// 宿主侧环境探测：本地依赖工具 / 便捷路径 / 网络连通 / 磁盘读写速度。
//
// 运行环境：DSH 宿主进程（web/headless 服务器），非工具沙箱——子进程、网络、
// 磁盘均可用。纪律：全部 fail-soft，任何失败只丢弃对应字段，绝不抛到插件主流程；
// 每条探测都必须有超时，禁止阻塞会话启动。
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'

// 常见本地依赖候选。骨架期只探测「是否存在」，版本探测留作后续
// （每条多一次子进程 + 解析开销，见 README 路线图）。
const TOOL_CANDIDATES = [
  'git', 'node', 'npm', 'pnpm', 'yarn', 'bun',
  'python', 'py', 'pip', 'uv', 'conda',
  'cargo', 'go', 'rustc', 'dotnet', 'java',
  'code', 'rg', 'fd', 'fzf', 'jq',
  'curl', 'wget', 'tar', '7z', 'ffmpeg',
  'wsl', 'docker', 'mysql', 'sqlite3', 'pwsh',
]

/** 有界并发 map（p-limit 极简版，limit 个 worker 顺序取任务）。 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

/** where.exe 查一个命令是否存在；失败/超时返回 null。 */
function whereIs(candidate, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile('where.exe', [candidate], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
        if (error) return resolve(null)
        const line = String(stdout).split(/\r?\n/).find((l) => l.trim() !== '')
        resolve(line ? path.basename(line).replace(/\.(exe|cmd|bat|ps1)$/i, '') : candidate)
      })
    } catch {
      resolve(null)
    }
  })
}

/** 探测本地依赖：并发 8 路 where.exe，返回排序后的可用命令名。 */
export async function probeTools(timeoutMs) {
  const found = await mapLimit(TOOL_CANDIDATES, 8, (tool) => whereIs(tool, timeoutMs))
  return found.filter((tool) => tool !== null).sort()
}

/** 便捷路径：仅记录「确实存在」的目录/文件（纯存在性检查，无子进程）。 */
export async function probePaths() {
  const home = os.homedir()
  const localAppData = process.env.LOCALAPPDATA
  const appData = process.env.APPDATA
  const temp = process.env.TEMP ?? os.tmpdir()
  const candidates = {
    home,
    desktop: path.join(home, 'Desktop'),
    documents: path.join(home, 'Documents'),
    downloads: path.join(home, 'Downloads'),
    'one-drive': process.env.OneDrive ?? process.env.OneDriveConsumer,
    localAppData,
    appData,
    temp,
    ssh: path.join(home, '.ssh'),
    gitConfig: path.join(home, '.gitconfig'),
    npmCache: localAppData ? path.join(localAppData, 'npm-cache') : null,
    pnpmStore: localAppData ? path.join(localAppData, 'pnpm', 'store') : null,
  }
  const found = {}
  for (const [name, p] of Object.entries(candidates)) {
    if (!p) continue
    try {
      await fs.access(p)
      found[name] = p
    } catch {
      // 不存在即跳过
    }
  }
  return found
}

/** 网络连通性：TCP 443 建连耗时（不发数据，极轻量；失败 = 不可达）。 */
export function probeNetwork(host, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const socket = net.connect({ host, port: 443 })
    const finish = (result) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    const start = Date.now()
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish({ host, reachable: true, ms: Date.now() - start }))
    socket.once('timeout', () => finish({ host, reachable: false, ms: null }))
    socket.once('error', () => finish({ host, reachable: false, ms: null }))
  })
}

/** 磁盘读写速度采样：临时目录写入/读回 1 MiB，随后清理。 */
export async function probeDisk(dir, timeoutMs) {
  const bytes = 1 << 20 // 1 MiB
  const file = path.join(dir, `.dsh-env-probe-${process.pid}-${Date.now()}.tmp`)
  const buffer = Buffer.alloc(bytes, 0x61)
  try {
    let writeMs = 0
    {
      const start = Date.now()
      await fs.writeFile(file, buffer)
      writeMs = Date.now() - start
    }
    let readMs = 0
    {
      const start = Date.now()
      await fs.readFile(file)
      readMs = Date.now() - start
    }
    return { dir, bytes, writeMs, readMs }
  } catch {
    return null
  } finally {
    await fs.rm(file, { force: true }).catch(() => {})
  }
}

/** 完整一轮探测：工具/网络/磁盘并行，路径单独跑。返回 env_record 载荷。 */
export async function probeAll(config) {
  const [tools, network, disk] = await Promise.all([
    probeTools(config.probeTimeoutMs),
    probeNetwork(config.networkHost, config.probeTimeoutMs),
    probeDisk(os.tmpdir(), config.probeTimeoutMs * 2),
  ])
  const paths = await probePaths()
  return {
    machine: os.hostname(),
    platform: process.platform,
    probedAt: Date.now(),
    tools,
    paths,
    network,
    disk,
    version: 1,
  }
}
