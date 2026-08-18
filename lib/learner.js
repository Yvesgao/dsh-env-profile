// LLM 自动抽取知识条目：每 learnIntervalTurns 轮，用「会话自身模型」对增量
// 会话片段做一次抽取调用，把持久事实写入 store.facts（随 summarize() 自动
// 进入每轮注入摘要，跨会话复用）。
//
// 成本与安全纪律（对齐 dsh-persona-memory 的后台学习思路）：
//  - 只抽取自上次抽取以来的增量事件（按 seq 游标），输入严格截断
//    （learnMaxInputChars，默认 8k 字符），输出上限 learnMaxOutputTokens；
//  - 只在 turn/end 且达到轮次间隔时触发，零失败影响：任何异常只记日志，
//    绝不抛进事件流，绝不阻塞会话；
//  - 跳过子代理会话（delegationDepth > 0，避免合成对话污染知识库）；
//  - 知识条目经 store.remember() 按规范化文本去重 + 计数，重复抽取自然收敛。
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const FACT_KINDS = new Set(['preference', 'path', 'dependency', 'convention', 'other'])

const EXTRACTION_SYSTEM = `你是 DSH（DeepSeek Harness）的"全局经验"抽取器。从用户提供的会话片段中，提取【值得跨会话长期记住】的持久事实：用户偏好、环境事实、项目约定、常用路径、依赖与工具。

直接输出结果，不要任何思考过程、不要解释、不要 markdown 代码块标记。只输出一个 JSON 数组。
数组元素格式：{"kind": "...", "text": "..."}
kind 取值：
- preference：用户的表达/沟通/格式/语言偏好、禁忌、纠正
- path：反复出现的目录/文件路径、项目根、缓存位置
- dependency：项目/系统依赖、工具、命令约定（构建命令、端口、脚本）
- convention：项目约定、架构决策、命名/流程规范
- other：其他值得记住的稳定事实

规则：
- 只提取稳定、可复用的事实；忽略一次性任务内容、临时数据、具体数值统计
- text 用中文、陈述句、具体可执行，不超过 40 字
- 没有可提取的事实也要输出 []`

/** 从事件流构建紧凑摘要文本（仅 surface 事件，尾偏截断）。 */
function buildTranscript(events, maxChars) {
  const pairing = new Map() // callId -> toolName
  const parts = []
  let chars = 0
  const push = (s) => {
    if (chars >= maxChars) return
    const rest = maxChars - chars
    parts.push(s.length > rest ? s.slice(-rest) : s)
    chars += s.length
  }
  const textOf = (content) =>
    (content ?? [])
      .map((block) => {
        if (block.type === 'text') return block.text
        if (Array.isArray(block.content)) return textOf(block.content)
        return ''
      })
      .join(' ')
      .trim()

  for (const event of events) {
    if (event.type === 'user/message') {
      const text = textOf(event.data.content)
      if (text) push(`用户：${text}\n`)
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.data.message.content)
      if (text) push(`助手：${text.slice(0, 200)}\n`)
    } else if (event.type === 'tool/call') {
      pairing.set(String(event.data.callId), event.data.name)
    } else if (event.type === 'tool/result') {
      const callId = String(event.data?.message?.content?.[0]?.toolCallId ?? '')
      const name = pairing.get(callId) ?? 'unknown'
      const text = textOf(event.data?.message?.content)
      const flag = event.data?.error ? '[失败]' : ''
      push(`工具[${name}]${flag}：${text.slice(0, 120)}\n`)
      if (callId) pairing.delete(callId)
    }
  }
  return parts.join('').trim()
}

/** 解析抽取模型的 JSON 输出（剥 markdown 围栏 + 兜底找数组）。 */
export function parseFacts(raw, maxFacts) {
  let text = String(raw ?? '').trim()
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/m, '').trim()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    const match = text.match(/\[[\s\S]*\]/)
    if (!match) return []
    try {
      data = JSON.parse(match[0])
    } catch {
      return []
    }
  }
  if (!Array.isArray(data)) return []
  return data
    .filter((f) => f && typeof f === 'object' && typeof f.text === 'string' && f.text.trim().length > 0)
    .map((f) => ({
      kind: FACT_KINDS.has(f.kind) ? f.kind : 'other',
      text: f.text.trim().slice(0, 120),
    }))
    .slice(0, maxFacts)
}

export function installLearner(ctx, config, store) {
  if (config.learnEnabled === false) return () => {}

  const lastSeqs = new Map() // sessionId -> 上次抽取的 seq（内存游标，重启后重抽近段，去重兜底）
  const turnCounts = new Map() // sessionId -> turn 计数
  let disposed = false

  const onTurnEnd = (session) => {
    if (disposed) return
    // 跳过子代理会话（合成对话，不污染全局知识）
    if ((session.header?.delegationDepth ?? 0) > 0) return
    const id = session.id
    const count = (turnCounts.get(id) ?? 0) + 1
    turnCounts.set(id, count)
    if (count % config.learnIntervalTurns !== 0) return
    void runExtraction(session)
  }

  const runExtraction = async (session) => {
    try {
      const id = session.id
      const fromSeq = lastSeqs.get(id) ?? 0
      const events = session.events.filter((event) => event.seq > fromSeq)
      lastSeqs.set(id, session.seq) // 先推进游标，防止并发重复抽取
      if (events.length === 0) return

      const transcript = buildTranscript(events, config.learnMaxInputChars)
      if (!transcript) return

      // 用会话自身模型（request/header 记录的 provider/model）
      const header = session.requestHeader?.()
      const provider = header?.config?.provider
      const model = header?.config?.model
      if (!provider || !model) {
        ctx.logger.warn(`dsh-env-profile: extraction skipped for ${id}: no model route in session header`)
        return
      }

      let output = ''
      let finishReason = null
      for await (const chunk of ctx.llm.stream({
        provider,
        model,
        system: EXTRACTION_SYSTEM,
        messages: [createUserMessage({ content: [{ type: 'text', text: `会话片段：\n${transcript}` }] })],
        temperature: 0.2,
        maxTokens: config.learnMaxOutputTokens,
      })) {
        if (chunk.type === 'text-delta') output += chunk.text
        else if (chunk.type === 'finish') finishReason = chunk.reason
      }

      // 推理模型（如 deepseek-v4-flash）的 reasoning 会先吃掉输出预算：
      // 输出为空时记录 finish reason，便于诊断，不再静默。
      if (!output.trim()) {
        ctx.logger.warn(`dsh-env-profile: extraction returned empty output (finish=${String(finishReason ?? '?')}); consider raising learnMaxOutputTokens`)
        return
      }

      const facts = parseFacts(output, config.learnMaxFactsPerRun)
      for (const fact of facts) {
        await store.remember(fact.kind, fact.text, id, session.seq)
      }
      if (facts.length > 0) {
        ctx.logger.info(`dsh-env-profile: learned ${facts.length} fact(s) from ${id} (finish=${String(finishReason ?? '?')})`)
      }
    } catch (error) {
      // 抽取失败绝不影响会话：只记日志
      ctx.logger.warn(`dsh-env-profile: extraction failed (fail-soft): ${String(error)}`)
    }
  }

  const dispose = ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') onTurnEnd(session)
  })

  return () => {
    if (disposed) return
    disposed = true
    dispose()
    lastSeqs.clear()
    turnCounts.clear()
  }
}
