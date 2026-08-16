// env_profile 工具：按需查询全局经验档案。
//
// 环境摘要已自动注入系统提示（见 injector.js），因此本工具用于三种场景：
//  1) 要完整档案（env 全量 JSON / 历史会话明细 / 全量知识条目）；
//  2) 要按类别过滤的知识条目；
//  3) 强制重跑一轮环境探测（refresh: true）。
import { defineTool } from '@deepseek-ai/dsh-tools'

export function installTool(ctx, config, store) {
  const dispose = ctx.tools.register(
    defineTool({
      name: 'env_profile',
      description:
        'Query the DSH global experience archive: host environment probes (local dependencies, convenient paths, network latency, disk speed), per-session statistics, and accumulated knowledge facts. A short summary is already injected into your system prompt; use this tool only when you need the full archive, a filtered fact list, or a forced re-probe of the host environment.',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['summary', 'env', 'sessions', 'facts', 'all'],
            description: 'Which part of the archive to return. Default: all.',
          },
          kind: {
            type: 'string',
            enum: ['preference', 'path', 'dependency', 'convention', 'other'],
            description: 'With scope=facts: filter knowledge entries by kind.',
          },
          limit: {
            type: 'integer',
            description: 'Max rows for sessions/facts. Default: 20.',
          },
          refresh: {
            type: 'boolean',
            description: 'Re-run host probes now (tools/paths/network/disk) before answering.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
      async execute(args) {
        if (args.refresh) await store.reprobe()
        const scope = args.scope ?? 'all'
        return { text: store.renderScope(scope, { kind: args.kind, limit: args.limit }) }
      },
    }),
  )
  return dispose
}
