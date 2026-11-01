// 注入器：把环境经验接进 system-prompt（每个 agent 请求都会组装）。
//
// DSH 0.2 的三段式分工（@deepseek-ai/dsh-system-prompt）：
//  - section：静态骨架，文本是常量、逐字节稳定；只在里面写 `{{env_summary}}`，
//    渲染时才求值 —— 所以档案刷新不会改动 section 本身。
//  - variable：`{{env_summary}}` 的提供者，返回机器档案（工具/版本/路径/网络/磁盘）。
//    只有重测后才会变，命中缓存时前缀逐字节相同。
//  - context：动态事实（知识条目 + 会话/条目计数），独立 user-role 快照；
//    harness 只在渲染结果变化时写入新快照，因此 cache-safe —— 这正是 0.2 让
//    「每轮都可能变」的内容离开静态 section 的原因。
//
// 顺序：section 取中心分配表里 TOOL_EDIT（1300）的位置（工具引导之后、超大稳定
// 前缀之后）；context 排在中心分配的 runtime-context 之后。两者都 fail-soft 回退
// 到本地默认值，便于在旧版上降级。
export function installInjector(ctx, config, store) {
  const prompt = ctx.systemPrompt
  let sectionOrder = config.injectOrder
  let contextOrder = 250
  try {
    const allocated = prompt.getSectionOrder('TOOL_EDIT')
    if (Number.isFinite(allocated)) sectionOrder = allocated
  } catch {
    // 0.1 没有中心分配表：沿用插件配置的 order。
  }
  try {
    const allocated = prompt.getContextOrder('HARNESS_SOURCE')
    if (Number.isFinite(allocated)) contextOrder = allocated + 10
  } catch {
    // 同上。
  }

  const disposers = [
    prompt.section({
      name: config.injectSectionName,
      order: sectionOrder,
      // 静态骨架：常量文本 + 唯一的变量引用。字节稳定，不进 KV cache 失效面。
      text: [
        '## Environment profile',
        '{{env_summary}}',
        'Full archive (env / sessions / facts) is available through the `env_profile` tool.',
      ].join('\n'),
    }),
    prompt.variable('env_summary', () => store.summarizeEnv()),
    prompt.context({
      name: `${config.injectSectionName}-dynamic`,
      order: contextOrder,
      // 动态事实：知识条目随会话学习增长，只在变化时产生新快照。
      text: () => store.summarizeDynamic(),
    }),
  ]

  return () => {
    for (const dispose of disposers) dispose()
  }
}
