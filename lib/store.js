// 经验库：内存镜像 + 写回存储领域（env_profile domain）。
//
// 读写纪律（对齐 dsh-storage-domain 的约定）：
//  - get / entries / keys 同步（读内存镜像）；put / delete / update 返回 Promise
//    （领域写链串行化：先经 json 后端整文件原子替换，再更新内存并发 domain/changed）。
//  - summarize() 必须同步且确定：同一档案状态下输出字节一致——
//    这是 system-prompt 前缀稳定、KV cache 持续命中的前提。
import { probeAll } from './probes.js'

const slugify = (text) =>
  String(text).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\u4e00-\u9fff-]/g, '') || 'fact'

const now = () => Date.now()

export class EnvProfileStore {
  constructor(ctx, tables, config) {
    this.ctx = ctx
    this.tables = tables
    this.config = config
    this.env = null // 内存镜像：机器环境档案
    this.facts = new Map() // 内存镜像：知识条目（key = slugify(text)）
    this.sessions = new Map() // 内存镜像：会话统计（key = sessionId，最多保留 200 条）
    this.summaryCache = null
  }

  /** 启动装载：整域读入内存镜像（json 后端一次文件读，代价小）。 */
  async init() {
    this.env = this.tables.env.get('current') ?? null
    for (const [key, record] of this.tables.facts.entries()) this.facts.set(key, record)
    for (const [key, record] of this.tables.sessions.entries()) this.sessions.set(key, record)
    this.trimSessions()
    this.summaryCache = null
  }

  /** 内存会话镜像剪枝：只留最近 200 条，存储表同步删除更旧记录（防 json 膨胀）。 */
  trimSessions() {
    const sorted = [...this.sessions.entries()].sort((a, b) => b[1].lastActivityAt - a[1].lastActivityAt)
    const keep = new Set(sorted.slice(0, 200).map(([key]) => key))
    for (const key of this.tables.sessions.keys()) {
      if (!keep.has(key)) void this.tables.sessions.delete(key).catch(() => {})
    }
    for (const [key] of sorted.slice(200)) this.sessions.delete(key)
  }

  /** 档案内容变化后调用：使摘要缓存失效（下次 assemble 重新拼）。 */
  invalidate() {
    this.summaryCache = null
  }

  // ---- 环境档案 ----

  /** 档案缺失或超过 probeIntervalHours 则重测并落库；探测失败保留旧档案。 */
  async ensureProbed() {
    const fresh = this.env && now() - this.env.probedAt < this.config.probeIntervalHours * 3_600_000
    if (fresh) return this.env
    try {
      const record = await probeAll(this.config)
      this.env = record
      await this.tables.env.put('current', record)
      this.invalidate()
      return record
    } catch (error) {
      this.ctx.logger.warn(`dsh-env-profile: probe failed, keeping stale archive: ${String(error)}`)
      return this.env
    }
  }

  /** 强制重测（env_profile 工具 refresh 参数用）。 */
  async reprobe() {
    try {
      const record = await probeAll(this.config)
      this.env = record
      await this.tables.env.put('current', record)
      this.invalidate()
      return record
    } catch (error) {
      this.ctx.logger.warn(`dsh-env-profile: reprobe failed: ${String(error)}`)
      return this.env
    }
  }

  // ---- 会话统计 ----

  /** 整条替换式写入一条会话观测（collector 每次 flush 的是完整快照）。 */
  async putSession(sessionId, row) {
    this.sessions.set(sessionId, row)
    this.trimSessions()
    this.invalidate()
    await this.tables.sessions.put(sessionId, row)
    return row
  }

  // ---- 知识条目 ----

  /**
   * 沉淀一条知识。按规范化文本去重：已存在则 count+1、刷新 lastSeen、
   * 记录来源会话（保留最近 20 个）。key 与 init() 装载键一致。
   */
  async remember(kind, text, sessionId) {
    const key = slugify(text)
    const previous = this.facts.get(key)
    const at = now()
    const record = previous
      ? {
          ...previous,
          lastSeen: at,
          count: previous.count + 1,
          sessionIds: [...new Set([...previous.sessionIds, ...(sessionId ? [sessionId] : [])])].slice(-20),
        }
      : { kind, text: String(text).trim(), firstSeen: at, lastSeen: at, count: 1, sessionIds: sessionId ? [sessionId] : [] }
    this.facts.set(key, record)
    this.invalidate()
    await this.tables.facts.put(key, record)
    return record
  }

  /** 按 (count 降序, lastSeen 降序) 取 Top 知识条目。 */
  topFacts(limit) {
    return [...this.facts.values()]
      .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
      .slice(0, limit)
  }

  // ---- 摘要（注入器用；同步 + 确定性）----

  /**
   * 拼装注入文本。注意：
   *  - 排序与格式全部确定（工具名排序、路径按固定键序、条目按稳定排序）；
   *  - 同一档案状态，连续调用输出逐字节相同 → 请求前缀稳定 → KV cache 命中；
   *  - 超预算截断并明示「用 env_profile 工具取全量」，绝不含糊。
   */
  summarize(maxChars = this.config.injectMaxChars, maxFacts = this.config.maxFactsInjected) {
    if (this.summaryCache) return this.summaryCache
    const lines = []
    if (this.env) {
      lines.push(`host: ${this.env.machine} (${this.env.platform})`)
      if (this.env.tools.length) lines.push(`tools: ${this.env.tools.join(', ')}`)
      const pathLine = Object.entries(this.env.paths)
        .slice(0, 8)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ')
      if (pathLine) lines.push(`paths: ${pathLine}`)
      const net = this.env.network
      if (net) lines.push(`net: ${net.reachable ? `ok ${net.ms}ms` : 'unreachable'} -> ${net.host}`)
      const disk = this.env.disk
      if (disk) lines.push(`disk: write ${disk.writeMs}ms / read ${disk.readMs}ms (${disk.bytes >> 10}KiB)`)
    }
    for (const fact of this.topFacts(maxFacts)) lines.push(`- [${fact.kind}] ${fact.text}`)
    if (this.sessions.size > 0) lines.push(`sessions tracked: ${this.sessions.size}`)
    let text = lines.join('\n')
    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars)}\n…(truncated — call env_profile for the full archive)`
    }
    if (!text) text = 'collecting environment profile…'
    this.summaryCache = text
    return text
  }

  // ---- 查询（env_profile 工具用）----

  renderScope(scope, options = {}) {
    const limit = options.limit ?? 20
    const parts = []
    if (scope === 'env' || scope === 'all') {
      parts.push('== env ==')
      parts.push(this.env ? JSON.stringify(this.env, null, 2) : '(not yet probed)')
    }
    if (scope === 'sessions' || scope === 'all') {
      parts.push('== sessions ==')
      const rows = [...this.sessions.entries()]
        .sort((a, b) => b[1].lastActivityAt - a[1].lastActivityAt)
        .slice(0, limit)
      if (rows.length === 0) parts.push('(none)')
      for (const [id, row] of rows) {
        const calls = Object.values(row.toolCalls).reduce((a, b) => a + b, 0)
        const errors = Object.values(row.toolErrors).reduce((a, b) => a + b, 0)
        parts.push(
          `${id}\n  cwd=${row.cwd ?? '-'} turns=${row.turns} calls=${calls} errors=${errors} llmMs=${row.llmMs ?? '-'} toolMs=${row.toolMs ?? '-'} cacheRead=${row.cacheReadTokens ?? '-'}`,
        )
      }
    }
    if (scope === 'facts' || scope === 'all') {
      parts.push('== facts ==')
      const facts = [...this.facts.values()]
        .filter((fact) => !options.kind || fact.kind === options.kind)
        .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
        .slice(0, limit)
      if (facts.length === 0) parts.push('(none)')
      for (const fact of facts) {
        parts.push(`[${fact.kind}] x${fact.count} ${fact.text} (${new Date(fact.lastSeen).toISOString().slice(0, 16)})`)
      }
    }
    if (scope === 'summary' || parts.length === 0) {
      parts.push('== summary ==')
      parts.push(this.summarize())
    }
    return parts.join('\n')
  }
}
