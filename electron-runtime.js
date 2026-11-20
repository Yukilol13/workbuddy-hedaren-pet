/**
 * 通用 Electron 运行时解析（WorkBuddy 桌宠 · 所有人可用）
 *
 * 桌宠窗口必须跑在 Electron 上。本模块保证任意一台装了 WorkBuddy 的电脑都能拿到 Electron：
 *
 *   1) 环境变量指定     PET_ELECTRON_PATH / HEDAREN_ELECTRON_PATH
 *   2) 项目内已下载     vendor/electron/  （install 时下载一次，永久复用）
 *   3) 复用旧 DSH 目录  ~/.dsh/electron/   （本机若有，秒用，零下载）
 *   4) 系统常见全局路径
 *   5) 以上都没有 → 从国内镜像下载便携版 Electron 并解压到 vendor/electron/
 *
 * 解压使用纯 JS（node:zlib inflateRaw），不依赖 unzip/tar/7z —— 真正跨平台零外部依赖。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream, renameSync, rmSync, chmodSync } from 'node:fs'
import { homedir, platform, arch } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { spawn } from 'node:child_process'
import { get as httpGet } from 'node:https'
import { get as plainHttpGet } from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
export const VENDOR_DIR = join(HERE, 'vendor', 'electron')
export const DEFAULT_VERSION = process.env.PET_ELECTRON_VERSION || '43.3.0'

const MIRRORS = [
  (v, f) => `https://npmmirror.com/mirrors/electron/${v}/${f}`,
  (v, f) => `https://registry.npmmirror.com/-/binary/electron/${v}/${f}`,
  (v, f) => `https://github.com/electron/electron/releases/download/v${v}/${f}`,
]

/** 依据平台返回 Electron 可执行文件路径候选（相对 electron 根目录） */
export function electronExeCandidates(electronRoot) {
  const p = platform()
  if (p === 'win32') return [join(electronRoot, 'electron.exe')]
  if (p === 'darwin') {
    return [
      join(electronRoot, 'Electron.app', 'Contents', 'MacOS', 'Electron'),
      join(electronRoot, 'electron'),
    ]
  }
  return [join(electronRoot, 'electron'), join(electronRoot, 'electron', 'electron')]
}

function firstExisting(candidates) {
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

/** 探测本机已有的 Electron 运行时（不触发下载） */
export function detectElectron() {
  // 1. 显式环境变量
  for (const key of ['PET_ELECTRON_PATH', 'HEDAREN_ELECTRON_PATH', 'ELECTRON_PATH']) {
    const v = process.env[key]
    if (v && existsSync(v)) return { path: v, source: `env:${key}` }
  }

  // 2. 项目内已下载
  const vendored = firstExisting(electronExeCandidates(VENDOR_DIR))
  if (vendored) return { path: vendored, source: 'vendored' }

  // 3. 复用旧 DSH 目录（本机若有）
  const dshRoot = join(homedir(), '.dsh', 'electron')
  const dsh = firstExisting(electronExeCandidates(dshRoot))
  if (dsh) return { path: dsh, source: 'dsh-reuse' }

  // 4. 系统常见全局路径
  const home = homedir()
  const globals = []
  if (platform() === 'win32') {
    globals.push(
      join(home, 'AppData', 'Local', 'Programs', 'electron'),
      join(home, 'AppData', 'Roaming', 'npm', 'node_modules', 'electron', 'dist'),
    )
  } else if (platform() === 'darwin') {
    globals.push('/Applications/Electron.app/Contents/Resources')
  } else {
    globals.push('/usr/lib/electron', '/opt/electron')
  }
  for (const root of globals) {
    const hit = firstExisting(electronExeCandidates(root))
    if (hit) return { path: hit, source: 'global' }
  }

  return null
}

function zipName(version, p = platform(), a = arch()) {
  const os = p === 'win32' ? 'win32' : p === 'darwin' ? 'darwin' : 'linux'
  let cpu = a
  if (p === 'darwin' && a === 'arm64') cpu = 'arm64'
  if (!['x64', 'arm64', 'ia32', 'armv7l'].includes(cpu)) cpu = 'x64'
  return `electron-v${version}-${os}-${cpu}.zip`
}

function downloadToFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith('https:') ? httpGet : plainHttpGet
    const req = getter(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (WorkBuddy-HedarenPet)' },
      timeout: 20000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        downloadToFile(next, dest, onProgress).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode} ${url}`))
        return
      }
      const total = Number(res.headers['content-length']) || 0
      let got = 0
      const out = createWriteStream(dest)
      res.on('data', (chunk) => {
        got += chunk.length
        if (onProgress && total) onProgress(Math.round((got / total) * 100))
      })
      res.on('error', (e) => { out.destroy(); reject(e) })
      out.on('error', reject)
      out.on('finish', () => resolve())
      res.pipe(out)
    })
    req.on('timeout', () => req.destroy(new Error('download timeout')))
    req.on('error', reject)
  })
}

/** 纯 JS 解压 ZIP（支持 store=0 / deflate=8），带目录穿越防护 */
export function extractZip(zipPath, outDir) {
  const buf = readFileSync(zipPath)
  if (buf.length < 22) throw new Error('ZIP 文件过小')
  const u16 = (o) => buf.readUInt16LE(o)
  const u32 = (o) => buf.readUInt32LE(o)

  // 找 EOCD
  let eocd = -1
  const min = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= min; i--) {
    if (u32(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('找不到 ZIP 结束标记')

  const count = u16(eocd + 10)
  let off = u32(eocd + 16)

  mkdirSync(outDir, { recursive: true })

  for (let i = 0; i < count; i++) {
    if (u32(off) !== 0x02014b50) throw new Error(`中央目录条目损坏 @${off}`)
    const method = u16(off + 10)
    const compSize = u32(off + 20)
    const rawSize = u32(off + 24)
    const nameLen = u16(off + 28)
    const extraLen = u16(off + 30)
    const commentLen = u16(off + 32)
    const localOff = u32(off + 42)
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')
    off += 46 + nameLen + extraLen + commentLen

    // 安全：拒绝绝对路径与 .. 穿越
    const safe = name.replace(/\\/g, '/').replace(/^(\.\.\/)+/, '')
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || safe.includes('../')) continue
    const target = join(outDir, safe)

    if (name.endsWith('/')) { mkdirSync(target, { recursive: true }); continue }

    if (u32(localOff) !== 0x04034b50) throw new Error(`本地文件头损坏 @${localOff}`)
    const lNameLen = u16(localOff + 26)
    const lExtraLen = u16(localOff + 28)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const compressed = buf.subarray(dataStart, dataStart + compSize)

    let data
    if (method === 0) data = compressed
    else if (method === 8) data = inflateRawSync(compressed)
    else throw new Error(`不支持的压缩方法 ${method}（${name}）`)

    if (data.length !== rawSize) {
      // 大小不符不致命（个别 zip 描述字段不准），继续写入
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)

    // macOS / Linux 恢复可执行位
    if ((platform() !== 'win32') && /\.(app\/Contents\/MacOS\/|electron$|Electron$)/.test(name)) {
      try { chmodSync(target, 0o755) } catch {}
    }
  }
}

/** 下载并解压 Electron 到项目内，返回可执行文件路径 */
export async function downloadElectron({ version = DEFAULT_VERSION, onLog = () => {} } = {}) {
  const file = zipName(version)
  const tmpZip = join(HERE, 'vendor', `_${file}`)
  mkdirSync(dirname(tmpZip), { recursive: true })

  let lastErr
  for (const build of MIRRORS) {
    const url = build(version, file)
    try {
      onLog(`[electron] 正在下载 ${url}`)
      await downloadToFile(url, tmpZip, (pct) => {
        if (pct % 20 === 0) onLog(`[electron] 下载 ${pct}%`)
      })
      onLog('[electron] 下载完成，正在解压（纯 JS，约几秒）…')
      // 先清旧目录避免残留
      try { rmSync(VENDOR_DIR, { recursive: true, force: true }) } catch {}
      extractZip(tmpZip, VENDOR_DIR)
      try { rmSync(tmpZip, { force: true }) } catch {}
      writeFileSync(join(VENDOR_DIR, '.installed'), JSON.stringify({ version, file, at: Date.now() }, null, 2))

      const exe = firstExisting(electronExeCandidates(VENDOR_DIR))
      if (!exe) throw new Error('解压后找不到 Electron 可执行文件')
      onLog(`[electron] 就绪：${exe}`)
      return { path: exe, source: 'downloaded', version }
    } catch (e) {
      lastErr = e
      onLog(`[electron] 镜像失败：${e.message}，换下一个…`)
      try { rmSync(tmpZip, { force: true }) } catch {}
    }
  }
  throw new Error(`所有镜像均下载失败：${lastErr?.message || ''}`)
}

/** 保证拿到 Electron：优先探测，找不到自动下载 */
export async function ensureElectron({ onLog = () => {}, forceDownload = false } = {}) {
  if (!forceDownload) {
    const found = detectElectron()
    if (found) {
      onLog(`[electron] 复用已有运行时（${found.source}）：${found.path}`)
      return found
    }
  }
  onLog('[electron] 本机未发现 Electron，开始首次下载（一次性，约 100MB）…')
  return downloadElectron({ onLog })
}

/** 用 Electron 启动桌宠窗口 app 目录 */
export function spawnPet(electronPath, appDir, extraEnv = {}, opts = {}) {
  const env = { ...process.env, ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  // --pet-edition 只是给进程命令行打的版本标记（任务管理器/进程列表里可辨认），Electron 会忽略未知开关。
  const detached = Boolean(opts.detached)
  const child = spawn(electronPath, ['--pet-edition=workbuddy', appDir], {
    // detached：由自动拉起（autostart）等父进程会立刻退出的场景使用，
    // Electron 必须自带进程组 + 无管道，否则随父进程退出被连带回收。
    stdio: detached ? ['ignore', 'ignore', 'ignore'] : ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
    env,
    detached,
  })
  let stderr = ''
  child.stderr?.on('data', (d) => { stderr += d.toString() })
  child.on('error', (e) => { stderr += `\nspawn error: ${e.message}` })
  return { child, getStderr: () => stderr }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = process.argv[2] || 'detect'
  const log = (s) => console.log(s)
  if (cmd === 'detect') {
    const found = detectElectron()
    console.log(found ? JSON.stringify(found, null, 2) : 'NOT_FOUND')
  } else if (cmd === 'ensure') {
    const r = await ensureElectron({ onLog: log })
    console.log('RESULT=' + JSON.stringify(r))
  } else if (cmd === 'download') {
    const r = await downloadElectron({ onLog: log })
    console.log('RESULT=' + JSON.stringify(r))
  } else {
    console.log('用法: electron-runtime.js [detect|ensure|download]')
  }
}
