// env_profile 领域声明：DSH 全局经验档案的持久化形状。
//
// 存储介质由 dsh-storage-domain 的配置路由决定：web/headless 组合默认走 json
// 后端，落盘为 $DSH_HOME/storages/env_profile.json（与 workspace.json、
// session_projcache.json 同级）。schema 用 zod（profile 平铺依赖里已带 4.x）。
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

// 机器级环境档案（表 env，单条记录 key = "current"）。
// 全部由宿主侧探测（lib/probes.js）产生：模型不可写，探测失败即整体丢弃重测。
const envRecord = z.object({
  machine: z.string(),
  platform: z.string(),
  probedAt: z.number(),
  tools: z.array(z.string()), // 探测到的可用本地命令（where.exe 结果）
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
  version: 1,
  tables: {
    env: domainTable(envRecord),
    sessions: domainTable(sessionRecord),
    facts: domainTable(factRecord),
  },
})
