// env_profile 工具：按需查询全局经验档案，或主动沉淀一条知识。
//
// 环境摘要已自动注入系统提示（见 injector.js），因此本工具用于四种场景：
//  1) 要完整档案（env 全量 JSON / 历史会话明细 / 全量知识条目）；
//  2) 要按类别过滤的知识条目；
//  3) 强制重跑一轮环境探测（refresh: true）；
//  4) 用户说「记一下：...」时主动沉淀知识（remember 参数）。
//
// DSH 0.2 的 defineTool 要求 output 同时声明 schema 与 render
// （canonical value -> 模型可见 ContentBlock[] 的纯函数），否则注册即抛
// TypeError: must declare output { schema, render, presentationMeta? }。
import { defineTool } from '@deepseek-ai/dsh-tools'

export function installTool(ctx, config, store) {
  const dispose = ctx.tools.register(
    defineTool({
      name: 'env_profile',
      description:
        'Query the DSH global experience archive: host environment probes (local dependencies, convenient paths, network latency, disk speed), per-session statistics, and accumulated knowledge facts. A short summary is already injected into your system prompt; use this tool only when you need the full archive, a filtered fact list, a forced re-probe, or when the user asks you to remember a durable fact (remember = {kind, text}).',
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
          remember: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['preference', 'path', 'dependency', 'convention', 'other'],
                description: 'Knowledge kind of the fact to remember.',
              },
              text: {
                type: 'string',
                description: 'The durable fact, one sentence, <= 120 chars.',
              },
            },
            required: ['kind', 'text'],
            additionalProperties: false,
            description: 'When present, record a durable fact into the global archive instead of querying.',
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
        // 0.2 新增：canonical value（已通过 output.schema 校验）-> 内容块。
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args) {
        if (args.remember) {
          const fact = await store.remember(args.remember.kind, args.remember.text)
          ctx.logger.info(`dsh-env-profile: tool remembered [${fact.kind}] ${fact.text}`)
          return { text: `已记录知识：[${fact.kind}] ${fact.text}（累计出现 ${fact.count} 次，会进入后续会话的环境摘要）` }
        }
        if (args.refresh) await store.reprobe()
        const scope = args.scope ?? 'all'
        return { text: store.renderScope(scope, { kind: args.kind, limit: args.limit }) }
      },
    }),
  )
  return dispose
}
