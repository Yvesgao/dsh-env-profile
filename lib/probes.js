// 宿主侧环境探测：本地依赖工具（含版本与 PATH 首命中路径）/ 便捷路径 /
// 网络连通 / 磁盘读写速度。
//
// 运行环境：DSH 宿主进程（web/headless 服务器），非工具沙箱——子进程、网络、
// 磁盘均可用。纪律：全部 fail-soft，任何失败只丢弃对应字段，绝不抛到插件主流程；
// 每条探测都必须有超时，禁止阻塞会话启动。
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'

// 常见本地依赖候选。
const TOOL_CANDIDATES = [
  'git', 'node', 'npm', 'pnpm', 'yarn', 'bun',
  'python', 'py', 'pip', 'uv', 'conda',
  'cargo', 'go', 'rustc', 'dotnet', 'java',
  'code', 'rg', 'fd', 'fzf', 'jq',
  'curl', 'wget', 'tar', '7z', 'ffmpeg',
  'wsl', 'docker', 'mysql', 'sqlite3', 'pwsh',
]

// 已知版本参数的常用工具（0.1.4 起探测）。7z/wsl/pwsh 等无稳定
// 单一版本参数或启动慢，跳过版本查询（只记录存在 + 路径）。
const VERSION_FLAGS = {
  git: ['--version'],
  node: ['-v'],
  npm: ['-v'],
  pnpm: ['-v'],
  yarn: ['--version'],
  bun: ['--version'],
  python: ['--version'],
  py: ['--version'],
  pip: ['--version'],
  uv: ['--version'],
  conda: ['--version'],
  cargo: ['--version'],
  go: ['version'],
  rustc: ['--version'],
  dotnet: ['--version'],
  java: ['-version'], // 输出到 stderr
  code: ['--version'],
  rg: ['--version'],
  fd: ['--version'],
  fzf: ['--version'],
  jq: ['--version'],
  curl: ['--version'],
  wget: ['--version'],
  tar: ['--version'],
  ffmpeg: ['-version'],
  docker: ['--version'],
  mysql: ['--version'],
  sqlite3: ['--version'],
}

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

/**
 * where.exe 查一个命令：返回 { name, path }（PATH 首个命中路径）或 null。
 * path 用「首命中」：后续版本探测就跑这个可执行文件，保证版本对应实际解析到的工具。
 */
function whereIs(candidate, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile('where.exe', [candidate], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
        if (error) return resolve(null)
        const line = String(stdout).split(/\r?\n/).find((l) => l.trim() !== '')
        if (!line) return resolve(null)
        resolve({
          name: path.basename(line).replace(/\.(exe|cmd|bat|ps1)$/i, ''),
          path: line.trim(),
        })
      })
    } catch {
      resolve(null)
    }
  })
}

/** 跑一次版本查询：合并 stdout/stderr 取首行前 3 个词（紧凑版），失败返回 null。 */
function queryVersion(executable, flags, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile(executable, flags, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
        if (error && !stdout && !stderr) return resolve(null)
        const raw = `${stdout}\n${stderr}`
        const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0)
        if (!line) return resolve(null)
        resolve(line.split(/\s+/).slice(0, 3).join(' ').slice(0, 60))
      })
    } catch {
      resolve(null)
    }
  })
}

/**
 * 探测本地依赖详情：存在清单 + PATH 首命中路径 + 已知工具的版本。
 * 两段式：先 where 全候选（并发 8），再对命中的已知版本工具查版本（并发 6）。
 */
export async function probeToolDetails(timeoutMs) {
  const hits = (await mapLimit(TOOL_CANDIDATES, 8, (tool) => whereIs(tool, timeoutMs))).filter(Boolean)
  const tools = hits.map((h) => h.name).sort()
  const paths = Object.fromEntries(hits.map((h) => [h.name, h.path]))
  const versionable = hits.filter((h) => VERSION_FLAGS[h.name])
  const versionRows = await mapLimit(versionable, 6, async (h) => {
    const version = await queryVersion(h.path, VERSION_FLAGS[h.name], timeoutMs)
    return version ? [h.name, version] : null
  })
  const versions = Object.fromEntries(versionRows.filter(Boolean))
  return { tools, paths, versions }
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
  const [details, network, disk] = await Promise.all([
    probeToolDetails(config.probeTimeoutMs),
    probeNetwork(config.networkHost, config.probeTimeoutMs),
    probeDisk(os.tmpdir(), config.probeTimeoutMs * 2),
  ])
  const paths = await probePaths()
  return {
    machine: os.hostname(),
    platform: process.platform,
    probedAt: Date.now(),
    tools: details.tools,
    toolPaths: details.paths,
    toolVersions: details.versions,
    paths,
    network,
    disk,
    version: 1,
  }
}
