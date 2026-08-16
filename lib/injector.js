// 注入器：把环境摘要接进 system-prompt（每个 agent 请求都会组装）。
//
// KV cache 纪律（本插件省 token 的核心机制，务必保持）：
//  - 段放在 order 500（工具引导 100-199 之后）：摘要内容变化时，只有「摘要 +
//    会话历史」这段尾缀需要重发；harness 身份 / persona / 工具 schema 这些
//    体积最大的稳定前缀继续命中 DeepSeek 前缀缓存。
//  - 摘要由 store.summarize() 生成：同步、确定、字节稳定——档案状态不变则每轮
//    请求的 system-prompt 逐字节相同，前缀缓存持续命中。
//  - 预算严格（injectMaxChars 默认 600 字符），超限截断并引导模型用
//    env_profile 工具取全量，避免注入成本反超收益。
export function installInjector(ctx, config, store) {
  const disposers = [
    ctx.systemPrompt.section({
      name: config.injectSectionName,
      order: config.injectOrder,
      text: `## Environment profile\n{{env_profile}}`,
    }),
    ctx.systemPrompt.variable('env_profile', () =>
      store.summarize(config.injectMaxChars, config.maxFactsInjected),
    ),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
