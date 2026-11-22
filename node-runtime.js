/**
 * 和大人桌宠 · 运行时探测（跨机器通用）
 *
 * 为什么要有这个文件：
 *   以前的 hooks / MCP 注册是把「安装时那个 node.exe 的绝对路径」直接写进
 *   settings.json 和 mcp.json 的，例如：
 *       C:\Users\40406\.workbuddy\binaries\node\versions\22.22.2-6\node.exe
 *   到了别人的电脑上，用户名不同、WorkBuddy 版本不同（node 目录叫 22.21.x、
 *   24.x…），这条路径要么不存在，要么指向一个和 WorkBuddy 当前运行时对不上的
 *   旧 node —— 这就是「node.exe 版本不一致」和「装完用不了」的根因。
 *
 * 这里改成运行时探测，永远不写死版本号：
 *   1) HEDAREN_NODE_EXE 环境变量（用户手动指定，优先级最高）
 *   2) WorkBuddy 的 versions/current 指针文件（指向当前在用的那版）
 *   3) versions/ 下版本号最大的那版（没指针时兜底）
 *   4) 当前进程本身是 node 就用它
 *   5) PATH 里的 node
 *   6) 项目自带的 Electron（ELECTRON_RUN_AS_NODE=1，内置 Node 24，一定存在）
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WIN = platform() === 'win32'
const NODE_BIN = WIN ? 'node.exe' : 'node'

export function wbDir() {
  return process.env.WORKBUDDY_CONFIG_DIR || join(homedir(), '.workbuddy')
}

export function versionsRoot() {
  return join(wbDir(), 'binaries', 'node', 'versions')
}

/** 读 WorkBuddy 的 current 指针（内容是版本目录名，例如 22.22.2-6） */
function readCurrentPointer() {
  try {
    const txt = readFileSync(join(versionsRoot(), 'current'), 'utf8').trim()
    return txt || ''
  } catch {
    return ''
  }
}

function parseVer(name) {
  const m = String(name).match(/(\d+)\.(\d+)\.(\d+)(?:-(\d+))?/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] || 0)] : [0, 0, 0, 0]
}

/** versions/ 下所有可用版本，按版本号从高到低 */
export function listVersionedNodes() {
  const root = versionsRoot()
  const out = []
  try {
    for (const d of readdirSync(root)) {
      const exe = join(root, d, NODE_BIN)
      if (existsSync(exe)) out.push({ exe, version: d, ver: parseVer(d) })
    }
  } catch {}
  out.sort((a, b) => {
    for (let i = 0; i < 4; i++) if (a.ver[i] !== b.ver[i]) return b.ver[i] - a.ver[i]
    return 0
  })
  return out
}

/** PATH 里有没有 node（不执行它，只按常见位置找，避免多一次进程开销） */
function pathNode() {
  const dirs = String(process.env.PATH || '').split(WIN ? ';' : ':').filter(Boolean)
  for (const d of dirs) {
    const exe = join(d, NODE_BIN)
    try { if (existsSync(exe)) return exe } catch {}
  }
  return ''
}

export function electronExe() {
  const p = join(HERE, 'vendor', 'electron', WIN ? 'electron.exe' : 'electron')
  return existsSync(p) ? p : ''
}

/**
 * 解析运行时。返回 { exe, kind: 'node'|'electron', source, version }
 * kind === 'electron' 时必须带 env ELECTRON_RUN_AS_NODE=1 才能当 node 用。
 */
export function resolveRuntime() {
  const envExe = process.env.HEDAREN_NODE_EXE
  if (envExe && existsSync(envExe)) return { exe: envExe, kind: 'node', source: 'env:HEDAREN_NODE_EXE' }

  const cur = readCurrentPointer()
  if (cur) {
    const exe = join(versionsRoot(), cur, NODE_BIN)
    if (existsSync(exe)) return { exe, kind: 'node', source: 'workbuddy:current', version: cur }
  }

  const list = listVersionedNodes()
  if (list.length) return { exe: list[0].exe, kind: 'node', source: 'workbuddy:versions', version: list[0].version }

  const self = process.execPath
  if (basename(self).toLowerCase() === NODE_BIN.toLowerCase()) {
    return { exe: self, kind: 'node', source: 'self' }
  }

  const p = pathNode()
  if (p) return { exe: p, kind: 'node', source: 'PATH' }

  const e = electronExe()
  if (e) return { exe: e, kind: 'electron', source: 'project:electron' }

  return null
}

/** 给 spawn 用：命令 + 必要的环境变量 */
export function runtimeSpawn(scriptPath, args = []) {
  const rt = resolveRuntime()
  if (!rt) throw new Error('未找到可用的 Node 运行时（WorkBuddy 未安装或 node 被移除了？）')
  const env = { ...process.env }
  if (rt.kind === 'electron') env.ELECTRON_RUN_AS_NODE = '1'
  else delete env.ELECTRON_RUN_AS_NODE
  return { exe: rt.exe, args: [scriptPath, ...args], env, runtime: rt }
}

/**
 * hooks 里要写的那条命令行。
 *
 * 优先用项目里的包装脚本 bin/hedaren-node.cmd(.sh)——它在**每次执行时**才去找 node，
 * 所以 WorkBuddy 以后换 node 版本、换安装目录都不会让 hook 失效。
 * 包装脚本不在（比如老版本目录）时，退化成写死的当前 node 路径。
 */
export function hookCommandLine(scriptPath, extra = '') {
  const q = (p) => (WIN ? `"${p}"` : `'${p}'`)
  const wrapper = join(HERE, 'bin', WIN ? 'hedaren-node.cmd' : 'hedaren-node.sh')
  if (existsSync(wrapper)) {
    return `${q(wrapper)} ${q(scriptPath)}${extra ? ' ' + extra : ''}`
  }
  const rt = resolveRuntime()
  const exe = rt ? rt.exe : NODE_BIN
  return `${q(exe)} ${q(scriptPath)}${extra ? ' ' + extra : ''}`
}
