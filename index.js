// dsh-env-profile —— DSH 全局经验插件 v0.2（适配 DSH 0.2.1-rc.5）
//
// 四段式闭环：
//  1) 收集（lib/collector.js）：订阅 session/event，折叠每会话工具调用统计；
//     结合 sessionProjections 的 sessionStats/tokenUsage 行取得耗时与 token 账。
//  2) 探测（lib/probes.js）：宿主侧定期探测本地依赖工具 / 便捷路径 / 网络连通 /
//     磁盘速度，零模型成本、全部 fail-soft、逐条超时。
//  3) 沉淀（lib/store.js）：以 env_profile 存储领域（json 后端 ->
//     $DSH_HOME/storages/env_profile.json）持久化 机器档案 / 会话统计 / 知识条目。
//  4) 运用（lib/injector.js + lib/tool.js）：机器档案走 system-prompt 静态
//     section 的 {{env_summary}} 变量（字节稳定）；知识条目/计数走 context
//     （变化才写 user-role 快照）；env_profile 工具按需返回完整档案或强制重测。
//
// 0.2 迁移要点：
//  - 域 schema 改 zod + invalidRecords:'backup-and-skip' + version 2（lib/spec.js）。
//  - defineTool 必须声明 output.render（lib/tool.js）。
//  - snapshotJsonValue 从 dsh-session 移到 dsh-util-values（lib/collector.js）。
//  - 启动期 info 日志作为可断言锚点：domain 打开 + 探测到的工具数。
//
// 依赖注入：storageDomain / systemPrompt / tools / sessionProjections / llm
// （全部为官方 @deepseek-ai 服务，按 make-dsh-plugin 契约不声明依赖，
//   经 profile pnpm 平铺闭包解析）。
import z from '@deepseek-ai/schemastery'
import { envProfileDomainSpec } from './lib/spec.js'
import { EnvProfileStore } from './lib/store.js'
import { installCollector } from './lib/collector.js'
import { installInjector } from './lib/injector.js'
import { installTool } from './lib/tool.js'
import { installLearner } from './lib/learner.js'

export const name = 'dsh-env-profile'
export const inject = ['storageDomain', 'systemPrompt', 'tools', 'sessionProjections', 'llm']

export const Config = z.object({
  enabled: z.boolean().default(true),
  // 注入预算（字符）：摘要超过即截断并提示模型用 env_profile 工具取全量。
  injectMaxChars: z.natural().max(4096).default(600),
  // system-prompt 段名与顺序：500 置于工具引导（100-199）之后——
  // 摘要变化仅使尾缀缓存失效，稳定前缀（身份/persona/工具 schema）持续命中。
  injectSectionName: z.string().default('env-profile'),
  injectOrder: z.number().default(500),
  // 探测间隔（小时）与单条子探测超时（毫秒）。
  probeIntervalHours: z.number().min(0.1).default(6),
  probeTimeoutMs: z.natural().max(15000).default(2000),
  // 网络探测目标（TCP 443 连通性 + 建连耗时）。
  networkHost: z.string().default('api.deepseek.com'),
  trackSessions: z.boolean().default(true),
  // 会话统计写入节流（事件数 / 时间间隔，借鉴 session-projection-cache）。
  writeEveryEvents: z.natural().min(1).default(25),
  writeIntervalMs: z.natural().min(200).default(5000),
  // 知识条目存储上限与每次注入条数上限。
  maxFactsStored: z.natural().default(500),
  maxFactsInjected: z.natural().default(8),
  // LLM 自动抽取（lib/learner.js）：默认开启，每 learnIntervalTurns 轮用会话
  // 自身模型抽取增量片段中的持久事实（有 token 成本，可按需关闭）。
  // 注意：deepseek-v4-flash 等推理模型会先输出 reasoning，输出上限要留足
  // （2000 起；偏小会导致思考耗尽预算、正文为空——0.1.3 已实测修复）。
  learnEnabled: z.boolean().default(true),
  learnIntervalTurns: z.natural().min(2).default(10),
  learnMaxInputChars: z.natural().max(32000).default(8000),
  learnMaxOutputTokens: z.natural().max(8000).default(2000),
  learnMaxFactsPerRun: z.natural().max(50).default(8),
})

// Config schema 的默认值在第三方插件上不一定被自动套用，这里手动兜底合并。
const DEFAULT_CONFIG = {
  enabled: true,
  injectMaxChars: 600,
  injectSectionName: 'env-profile',
  injectOrder: 500,
  probeIntervalHours: 6,
  probeTimeoutMs: 2000,
  networkHost: 'api.deepseek.com',
  trackSessions: true,
  writeEveryEvents: 25,
  writeIntervalMs: 5000,
  maxFactsStored: 500,
  maxFactsInjected: 8,
  learnEnabled: true,
  learnIntervalTurns: 10,
  learnMaxInputChars: 8000,
  learnMaxOutputTokens: 2000,
  learnMaxFactsPerRun: 8,
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...rawConfig }
  if (config.enabled === false) return

  ctx.effect(
    async () => {
      // 打开存储领域（json 后端；读文件 -> 内存镜像 -> 写链串行持久化）。
      let domain
      try {
        domain = await ctx.storageDomain.open(envProfileDomainSpec)
      } catch (error) {
        ctx.logger.warn(`dsh-env-profile: storage domain unavailable, plugin disabled: ${String(error)}`)
        return () => {}
      }
      ctx.logger.info(`dsh-env-profile: storage domain opened (env_profile v${envProfileDomainSpec.version})`)

      const store = new EnvProfileStore(
        ctx,
        {
          env: domain.table('env'),
          sessions: domain.table('sessions'),
          facts: domain.table('facts'),
        },
        config,
      )
      await store.init()

      // 各部件独立安装：单个部件失败不影响其余（fail-soft）。
      const disposers = []
      for (const install of [installCollector, installInjector, installTool, installLearner]) {
        try {
          disposers.push(install(ctx, config, store))
        } catch (error) {
          ctx.logger.warn(`dsh-env-profile: ${install.name} failed to install: ${String(error)}`)
        }
      }

      // 首次探测不阻塞启动（异步触发，由 ensureProbed 按间隔自动刷新）。
      // 探测完成后打一条带工具数的 info：这是「域已打开且探测链路通了」的
      // 可断言锚点（domain opened, N tools probed）。
      void store
        .ensureProbed()
        .then((record) => {
          const probed = Array.isArray(record?.tools) ? record.tools.length : 0
          const line = `dsh-env-profile: domain opened, ${probed} tools probed`
          // 同时走 ctx.logger 与 console：host 的 logger 级别在 web/headless 下可能
          // 过滤掉第三方插件的 info，console 保证这行一定进进程 stdout（断言锚点）。
          ctx.logger.info(line)
          console.info(line)
        })
        .catch((error) => {
          ctx.logger.warn(`dsh-env-profile: initial probe failed (fail-soft): ${String(error)}`)
        })

      return async () => {
        for (const dispose of disposers) dispose()
        await domain.close()
      }
    },
    'dsh-env-profile.effect',
  )
}
