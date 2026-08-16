// 会话观测采集器：订阅 session/event，把工具调用/轮次/耗时/token 账折叠进
// 内存累加器，节流写回 store（对齐 session-projection-cache 的 write-behind 形态）。
//
// 事件载荷（dsh-session 持久化目录，已按本机 @deepseek-ai/dsh-session 源码核对）：
//   tool/call   { turn, step, callId, name, arguments }   —— 工具名只出现在这里
//   tool/result { turn, step, message: { content: [{ toolCallId }] }, error?, meta? }
//   turn/end    { turn }                                   —— 强制落盘点
// 耗时/token 账不直接出现在事件里，turn/end 时从 sessionProjections.checkpoint(session)
// 读取 sessionStats / tokenUsage 行（与 session_projcache 同一来源）。
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'

export function installCollector(ctx, config, store) {
  if (config.trackSessions === false) return () => {}

  const accumulators = new Map() // sessionId -> 累加器（完整快照，flush 后替换式写入）
  const pairing = new Map() // callId -> toolName（配对 tool/call 与 tool/result）
  const dirty = new Map() // sessionId -> { pending, timer }
  let disposed = false

  const accumulatorFor = (session) => {
    const id = session.id
    let acc = accumulators.get(id)
    if (!acc) {
      acc = {
        cwd: session.header?.cwd,
        createdAt: session.header?.createdAt ?? Date.now(),
        turns: 0,
        toolCalls: {},
        toolErrors: {},
        llmMs: 0,
        toolMs: 0,
        decodeTokens: 0,
        cacheReadTokens: 0,
        lastActivityAt: Date.now(),
      }
      accumulators.set(id, acc)
    }
    acc.lastActivityAt = Date.now()
    return acc
  }

  const schedule = (session) => {
    const id = session.id
    const state = dirty.get(id) ?? { pending: 0 }
    dirty.set(id, state)
    state.pending += 1
    if (state.pending >= config.writeEveryEvents) {
      void flush(session)
      return
    }
    state.timer ??= setTimeout(() => void flush(session), config.writeIntervalMs)
  }

  /** turn/end 时从投影缓存折叠 llmMs/toolMs/token 账（fail-soft）。 */
  const foldProjections = (session, acc) => {
    try {
      const checkpoint = ctx.sessionProjections?.checkpoint?.(session)
      const rows = checkpoint && typeof checkpoint === 'object' ? (checkpoint.rows ?? checkpoint) : undefined
      const stats = rows?.sessionStats?.val
      const usage = rows?.tokenUsage?.val
      if (stats) {
        acc.llmMs = stats.llmMs ?? acc.llmMs
        acc.toolMs = stats.toolMs ?? acc.toolMs
      }
      if (usage?.totals) {
        acc.decodeTokens = usage.totals.outputTokens ?? acc.decodeTokens
        acc.cacheReadTokens = usage.totals.cacheReadTokens ?? acc.cacheReadTokens
      }
    } catch {
      // 统计读取失败不影响事件流
    }
  }

  const onEvent = (session, event) => {
    const acc = accumulatorFor(session)
    if (event.type === 'tool/call') {
      acc.toolCalls[event.name] = (acc.toolCalls[event.name] ?? 0) + 1
      pairing.set(String(event.callId), event.name)
      schedule(session)
    } else if (event.type === 'tool/result') {
      const callId = String(event.message?.content?.[0]?.toolCallId ?? '')
      const name = callId ? (pairing.get(callId) ?? 'unknown') : 'unknown'
      if (event.error) acc.toolErrors[name] = (acc.toolErrors[name] ?? 0) + 1
      if (callId) pairing.delete(callId)
      schedule(session)
    } else if (event.type === 'turn/end') {
      acc.turns += 1
      foldProjections(session, acc)
      void flush(session)
    }
  }

  const flush = async (session) => {
    const id = session.id
    const state = dirty.get(id)
    if (state?.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    dirty.delete(id)
    const acc = accumulators.get(id)
    if (!acc) return
    const snapshot = snapshotJsonValue(acc)
    if (snapshot === undefined) return // 不可序列化则丢弃本次快照（不应发生）
    await store.putSession(id, snapshot)
  }

  const onDisposed = (session) => {
    void flush(session)
    accumulators.delete(session.id)
  }

  const disposeEvent = ctx.on('session/event', onEvent)
  const disposeDisposed = ctx.on('session/disposed', onDisposed)

  return () => {
    if (disposed) return
    disposed = true
    disposeEvent()
    disposeDisposed()
    for (const state of dirty.values()) if (state.timer !== undefined) clearTimeout(state.timer)
    dirty.clear()
  }
}
