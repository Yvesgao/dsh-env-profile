// env_profile 领域声明：DSH 全局经验档案的持久化形状。
//
// 存储介质由 dsh-storage-domain 的配置路由决定：web/headless 组合默认走 json
// 后端，落盘为 $DSH_HOME/storages/env_profile.json（与 workspace.json、
// session_projcache.json 同级）。
//
// DSH 0.2 契约（见 @deepseek-ai/dsh-storage-domain 的 spec.d.ts）：
//  - domain 的 record schema 必须是 zod（`ZodType`），open() 内直接 .parse()；
//    schemastery 只用于插件 Config。这里用 zod，并由 profile 的平铺闭包解析。
//  - 0.2 起 domain 版本升到 2：v1 的旧文件记录形状与 v2 相同（没有删字段），
//    因此显式声明 compatibleVersions: [1]，升级不丢档案。
//  - 本域的数据全部是「可重建的派生数据」：某条记录读不出/不合法时，整体
//    open 失败会让插件被禁用（0.1 的首要故障）。invalidRecords:
//    'backup-and-skip' 让后端把坏记录挪到一边、记日志、继续 open。
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

// 机器级环境档案（表 env，单条记录 key = "current"）。
// 全部由宿主侧探测（lib/probes.js）产生：模型不可写，探测失败即整体丢弃重测。
const envRecord = z.object({
  machine: z.string(),
  platform: z.string(),
  probedAt: z.number(),
  tools: z.array(z.string()), // 探测到的可用本地命令（where.exe 结果）
  toolPaths: z.record(z.string(), z.string()).optional(), // 0.1.4+：name -> PATH 首命中路径
  toolVersions: z.record(z.string(), z.string()).optional(), // 0.1.4+：name -> 版本首行（仅已知参数的工具）
  paths: z.record(z.string(), z.string()), // 便捷路径：name -> 存在的路径
  network: z.object({
    host: z.string(),
    reachable: z.boolean(),
    ms: z.number().nullable(), // TCP 443 建连耗时；不可达为 null
  }).nullable(),
  disk: z.object({
    dir: z.string(),
    bytes: z.number(),
    writeMs: z.number(),
    readMs: z.number(),
  }).nullable(),
  version: z.number(),
})

// 每会话观测统计（表 sessions，key = sessionId）。
// 由 lib/collector.js 从 session/event + sessionProjections 折叠，
// 纯确定性、零 LLM 成本；toolCalls/toolErrors 为工具名 -> 计数。
const sessionRecord = z.object({
  cwd: z.string().optional(),
  createdAt: z.number(),
  lastActivityAt: z.number(),
  turns: z.number(),
  toolCalls: z.record(z.string(), z.number()),
  toolErrors: z.record(z.string(), z.number()),
  llmMs: z.number().optional(),
  toolMs: z.number().optional(),
  decodeTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
})

// 知识条目（表 facts，key = slugify(text)）。
// 骨架期由宿主显式写入（如命令/设置项/便捷路径约定），
// 0.1.2 起由 lib/learner.js 用会话自身模型自动抽取（增量片段 + JSON 输出）。
// sourceSeq = 本次抽取依据的会话事件序号（溯源）。
const factRecord = z.object({
  kind: z.enum(['preference', 'path', 'dependency', 'convention', 'other']),
  text: z.string(),
  firstSeen: z.number(),
  lastSeen: z.number(),
  count: z.number(),
  sessionIds: z.array(z.string()),
  sourceSeq: z.number().optional(),
})

export const envProfileDomainSpec = defineDomain({
  name: 'env_profile',
  // DSH 0.2：记录 schema 由 schemastery 换成 zod，域格式版本随之升到 2。
  version: 2,
  // v1 记录没有删字段，v2 的 schema 仍能读，升级时原地复用旧档案。
  compatibleVersions: [1],
  // 派生数据：坏记录备份后跳过，绝不让整个域 open 失败（失败 = 插件被禁用）。
  invalidRecords: 'backup-and-skip',
  tables: {
    env: domainTable(envRecord),
    sessions: domainTable(sessionRecord),
    facts: domainTable(factRecord),
  },
})
