# dsh-env-profile（骨架）

DSH 全局经验插件：自动探测本地环境（依赖工具 / 便捷路径 / 网络 / 磁盘），
订阅 `session/event` 折叠每会话统计，沉淀为**跨会话的全局档案**，
并把低开销摘要注入**每一轮**系统提示——让每个会话开局就知道
「这台机器有什么、哪些路径靠谱、网络快不快、以往会话里沉淀过什么」，
减少重复探测与重复解释，加快会话、降低 token 消耗。

> 状态：**骨架 v0.1**。核心闭环（探测 → 沉淀 → 注入 → 查询）可用，
> LLM 自动抽取知识条目等进阶能力见文末「路线图」。

## 安装

> **本地开发先读这个坑（本机 2026-08-16 实测）**：`dsh plugin --profile web add link:<路径>`
> 装完会报 `Cannot find package '@deepseek-ai/schemastery'` 而无法加载。原因：
> 官方 `@deepseek-ai/*` 包不随插件分发，靠「插件的**真实文件**位于 profile 目录树内、
> Node 父目录上溯命中 `$DSH_HOME/profiles/node_modules` 平铺闭包」解析；
> pnpm 对本地路径依赖一律建 junction（真实路径在 profile 树外），ESM 解析必失败。
> 因此本地验证用**物理拷贝**（与 npm/git 安装的真实布局一致）：

```powershell
# 0) 前置：pnpm 需在 PATH（没有就装：npm i -g pnpm；或用 npx --yes pnpm@9 包一层 shim）

# 1) 登记依赖 + bundle 层（profile package.json 的 dsh.profile.bundles 会追加 dsh-env-profile）
dsh plugin --profile web add "E:\My Documents\DskHarness-PC\dsh-env-profile"

# 2) 用物理拷贝替换 pnpm 建的 junction（官方包解析的关键一步）
$dst = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-env-profile"
cmd /c rmdir "$dst"
Copy-Item -Recurse "E:\My Documents\DskHarness-PC\dsh-env-profile" "$dst"

# 3) 重启 dsh web 生效；改代码后重复 2)+3)（ESM 按 URL 缓存，必须重启）
```

不装 pnpm 的纯手工路径（等价）：在 `$env:USERPROFILE\.dsh\profiles\web\package.json`
的 `dsh.profile.bundles` 里追加 `"dsh-env-profile"`，然后直接把插件目录拷到
`$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-env-profile`，重启 web。

**正式分发**（npm / git 源，物理落盘进 profile，无上述问题）：

```sh
dsh plugin --profile web add dsh-env-profile          # 发布到 npm 后
# 或 git 源（产物已入库 lib/，无 prepare 构建）
dsh plugin --profile web add "github:Yvesgao/dsh-env-profile#v0.1.0"
```

重启 `dsh web` 后验证：

1. `$DSH_HOME/storages/` 下出现 `env_profile.json`（首次探测后，含 tools/paths/network/disk）；
2. 任意会话的系统提示尾部出现 `## Environment profile` 段；
3. 会话里问一句「这台机器装了哪些常用工具？网络到 api.deepseek.com 延迟多少？」
   模型直接答出，不再现场跑命令。

> headless profile 同样适用（把上面路径里的 `web` 换成 `headless`）。
> 卸载：`dsh plugin --profile web remove dsh-env-profile`。

## 闭环架构

```
 session/event ──▶ collector ──┐         ┌──▶ systemPrompt.section ──▶ 每轮注入
 (tool/call,result,turn/end)    │         │      (order 500, 预算 600 字符)
                               ├── store ─┤
 宿主探测(定时/手动) ──▶ probes ─┘  (env_profile 领域)  └──▶ env_profile 工具 ──▶ 按需查全量
 (where.exe/路径/TCP/磁盘采样)        │
                           $DSH_HOME/storages/env_profile.json
```

| 部件 | 文件 | 职责 |
|---|---|---|
| 领域声明 | `lib/spec.js` | zod schema：`env`（机器档案）/ `sessions`（会话统计）/ `facts`（知识条目）三张表 |
| 宿主探测 | `lib/probes.js` | `where.exe` 扫 33 个常见命令、便捷路径存在性、TCP 443 建连耗时、1 MiB 磁盘读写采样；并发 8 路、逐条超时、全 fail-soft |
| 经验库 | `lib/store.js` | 内存镜像 + 写回存储领域；`summarize()` 同步且**字节确定**（KV cache 稳定的前提）；`remember()` 知识条目去重沉淀；会话镜像剪枝（留 200 条，存储表同步删旧） |
| 采集器 | `lib/collector.js` | `tool/call` 记工具名（配对 `callId`），`tool/result` 记错误，`turn/end` 从 `sessionProjections` 折叠 `llmMs/toolMs/token 账`；节流写回（事件数/间隔双触发） |
| 注入器 | `lib/injector.js` | `systemPrompt.section`（order 500）+ `variable` 每轮求值摘要 |
| 查询工具 | `lib/tool.js` | `env_profile`：`scope=summary/env/sessions/facts/all`、`kind` 过滤、`refresh` 强制重测 |

## 省 token 的三个机制

1. **前缀缓存稳定**：摘要由 `store.summarize()` 生成——排序、格式全部确定，
   档案状态不变则每轮 system-prompt 逐字节相同，DeepSeek 前缀缓存持续命中；
   段放在 order 500（工具引导之后），即使摘要变化也只使尾缀失效，
   harness 身份 / persona / 工具 schema 这些大块稳定前缀照常命中。
2. **注入预算硬上限**：默认 600 字符，超限截断并明示「用 env_profile 工具取全量」，
   防止经验注入成本反超收益。
3. **探测零模型成本**：全部是宿主侧确定性操作（where.exe / 存在性检查 / TCP 建连 /
   1 MiB 读写），不占用任何 token，且按 `probeIntervalHours`（默认 6h）缓存。

## 配置

schema 见 `index.js` 的 `Config`，典型覆盖（profile 的 `cordis.patch.yml`，
顶层数组元素按行 id 覆盖，`config` 整体替换、未列出的键回落到插件默认值）：

```yaml
- id: env-profile
  config:
    injectMaxChars: 400        # 注入预算调小
    probeIntervalHours: 24     # 探测更懒
    networkHost: api.deepseek.com
    trackSessions: true
    learnEnabled: false        # 关闭 LLM 自动抽取（有 token 成本）
    learnIntervalTurns: 5      # 每 5 轮抽取一次（默认 10）
    learnMaxInputChars: 4000   # 抽取输入上限（默认 8000 字符）
```

## 已知边界（骨架期）

- **探测只覆盖 Windows**：`where.exe` 与 `%LOCALAPPDATA%` 等为 win32 约定；
  POSIX 版本需要改用 `command -v` 与 `$XDG_*`（见路线图）。
- **版本探测未做**：目前只记「命令是否存在」，不跑 `--version`（每条多一次子进程）。
- **抽取去重按规范化文本**：learner 与 `store.remember()` 用 slug 去重 + 计数，
  同义改写的事实可能并存（近义合并留作后续）。
- **单进程写约束**：json 后端无跨进程写锁，勿在多个 dsh 进程同时写同一 DSH_HOME。

## 路线图

- [x] LLM 自动抽取知识条目（0.1.2）：每 N 轮用会话自身模型复习增量片段，
      提取 用户偏好 / 项目约定 / 便捷路径 / 依赖工具（带 `sourceSeq` 溯源），
      条目自动进入每轮注入摘要
- [ ] POSIX 探测适配（`command -v` / XDG 目录 / `/dev/null` 磁盘采样）
- [ ] 关键工具版本探测（git/node/npm/pnpm/python）与 PATH 首个命中路径
- [ ] 近义知识合并（抽取时对已存条目做一次相似度过滤）
- [ ] 会话结果缓存：常见命令输出（如 `git status`、目录列表）跨会话复用
- [ ] Web 设置页（`settings.section` slot）查看/编辑档案与条目
- [ ] 与 dsh-mnemon / dsh-persona-memory 的记忆仓库互读

## 许可

MIT
