#!/usr/bin/env node
/**
 * 和大人桌宠 · WorkBuddy 一键安装器（通用版）
 *
 * 做四件事（全部幂等，可重复执行）：
 *   1) 确保 Electron 运行时（探测 → 没有就下载到项目内）
 *   2) 把工作状态 hooks 合并进 ~/.workbuddy/settings.json（带管理标记，卸载可清除）
 *   3) 把 MCP server 注册进 ~/.workbuddy/mcp.json（带管理标记）
 *   4) 生成 config.json 模板 + 首次启动桌宠窗口
 *
 * 用法：
 *   node install.js                 # 安装
 *   node install.js --no-start      # 只配置，不启动窗口
 *   node install.js --force-download# 强制重新下载 Electron
 *   node install.js --uninstall     # 卸载（移除 hooks / MCP 注册）
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { ensureElectron } from './electron-runtime.js'
import { init as coreInit } from './core.js'
import { hookCommandLine, resolveRuntime, wbDir as rtWbDir } from './node-runtime.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = homedir()
const WB_DIR = process.env.WORKBUDDY_CONFIG_DIR || join(HOME, '.workbuddy')
const SETTINGS = join(WB_DIR, 'settings.json')
const MCP_FILE = join(WB_DIR, 'mcp.json')

const HOOK_SCRIPT = join(HERE, 'hooks', 'pet-hook.js')
const MCP_SCRIPT = join(HERE, 'mcp-server.js')
const STATE_DIR = join(HOME, '.workbuddy', 'hedaren-pet')

// 用合法的 JSON 哨兵键做管理标记（settings.json 必须保持可被 JSON.parse 解析）
const HOOK_SENTINEL = '__hedaren_pet__'
const MCP_MARK = 'hedaren-pet'
// 我们管理的事件；卸载时只移除这些事件，不碰用户其它 hook
const MANAGED_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd']

const SKILL_DIR = join(WB_DIR, 'skills', 'hedaren-pet')

/** 用户手动开关：autostart.json 里 enabled === false 表示关（没写过 = 默认关） */
function readAutostartEnabled() {
  try {
    const raw = JSON.parse(readFileSync(join(STATE_DIR, 'autostart.json'), 'utf8'))
    return raw?.enabled === true
  } catch {
    return false
  }
}

const argv = process.argv.slice(2)
const noStart = argv.includes('--no-start')
const forceDownload = argv.includes('--force-download')
const uninstall = argv.includes('--uninstall')

function log(...a) { console.log('[install]', ...a) }

function backup(file) {
  if (!existsSync(file)) return
  const bak = `${file}.hedaren-pet.bak`
  try { copyFileSync(file, bak); log(`已备份 → ${bak}`) } catch (e) { log('备份失败（继续）：', e.message) }
}

/** 生成跨平台、带引号的 hook 命令（走 bin/hedaren-node 包装，运行时才解析 node，不写死版本） */
function nodeCmd(script, args = '') {
  return hookCommandLine(script, args)
}

/** 合并 hooks 到 settings.json（全程合法 JSON，哨兵键标记归属） */
function mergeHooks() {
  if (!existsSync(SETTINGS)) {
    log(`settings.json 不存在，跳过 hooks 注册：${SETTINGS}`)
    return false
  }
  let cfg
  try {
    cfg = JSON.parse(readFileSync(SETTINGS, 'utf8'))
  } catch (e) {
    log('⚠ settings.json 非法 JSON，跳过 hooks 注册：' + e.message)
    return false
  }
  if (!cfg.hooks || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks)) cfg.hooks = {}

  if (uninstall) {
    let removed = false
    for (const evt of MANAGED_EVENTS) {
      if (cfg.hooks[evt]) { delete cfg.hooks[evt]; removed = true }
    }
    if (cfg.hooks[HOOK_SENTINEL]) { delete cfg.hooks[HOOK_SENTINEL]; removed = true }
    if (removed) {
      backup(SETTINGS)
      writeFileSync(SETTINGS, JSON.stringify(cfg, null, 2), 'utf8')
      log('已从 settings.json 移除和大人 hooks')
    }
    return true
  }

  // 构造 hooks 片段：把 __HOOK_CMD__ 换成实际 node 命令，PLACEHOLDER 换成具体事件
  const frag = JSON.parse(readFileSync(join(HERE, 'hooks', 'hooks-fragment.json'), 'utf8'))
  const hookCmd = nodeCmd(HOOK_SCRIPT)
  for (const [evt, arr] of Object.entries(frag)) {
    for (const group of arr) {
      for (const h of group.hooks || []) {
        if (h.type === 'command') {
          h.command = h.command
            .replace('__HOOK_CMD__', hookCmd)
            .replace('--event PLACEHOLDER', `--event ${evt}`)
        }
      }
    }
  }

  // 只覆盖我们管理的事件，用户其它 hook 原样保留
  for (const evt of MANAGED_EVENTS) {
    if (frag[evt]) cfg.hooks[evt] = frag[evt]
  }
  cfg.hooks[HOOK_SENTINEL] = []

  // 自动唤醒默认关：autostart.json 说关着，就别留 SessionStart 这条（省一次进程启动，
  // 用户要开时在府邸勾选，由桌宠主进程自己把 hook 加回去）
  if (!readAutostartEnabled() && Array.isArray(cfg.hooks.SessionStart)) {
    cfg.hooks.SessionStart = cfg.hooks.SessionStart.filter(
      (g) => !(g?.hooks || []).some((h) => String(h?.command || '').includes('pet-hook.js')),
    )
    if (cfg.hooks.SessionStart.length === 0) delete cfg.hooks.SessionStart
    log('自动唤醒处于关闭状态，未注册 SessionStart hook')
  }

  backup(SETTINGS)
  writeFileSync(SETTINGS, JSON.stringify(cfg, null, 2), 'utf8')
  log(`已注册工作状态 hooks（${MANAGED_EVENTS.length} 类事件）→ ${SETTINGS}`)
  return true
}

/** 注册 MCP server 到 mcp.json */
function mergeMcp() {
  let cfg = { mcpServers: {} }
  if (existsSync(MCP_FILE)) {
    try { cfg = JSON.parse(readFileSync(MCP_FILE, 'utf8')) } catch (e) {
      log('⚠ mcp.json 非法，将重建：' + e.message)
      cfg = { mcpServers: {} }
    }
  }
  if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {}
  // 清理旧版本可能留下的下划线命名
  if (cfg.mcpServers['__hedaren_pet__']) delete cfg.mcpServers['__hedaren_pet__']

  if (uninstall) {
    if (cfg.mcpServers[MCP_MARK]) {
      delete cfg.mcpServers[MCP_MARK]
      backup(MCP_FILE)
      writeFileSync(MCP_FILE, JSON.stringify(cfg, null, 2), 'utf8')
      log('已从 mcp.json 移除和大人 MCP server')
    }
    return true
  }

  const rt = resolveRuntime()
  if (!rt) {
    log('⚠ 找不到可用的 Node 运行时，MCP 注册跳过（先装 WorkBuddy 再来）')
    return false
  }
  const env = { HEDAREN_PET_HOME: STATE_DIR }
  // Electron 当 node 用时必须开这个开关，否则它会把 mcp-server.js 当应用主入口
  if (rt.kind === 'electron') env.ELECTRON_RUN_AS_NODE = '1'
  const prev = cfg.mcpServers[MCP_MARK] || {}
  cfg.mcpServers[MCP_MARK] = {
    type: 'stdio',
    command: rt.exe,
    args: [MCP_SCRIPT],
    env,
    description: '和大人桌面宠物控制（说话/动作/国库/对话/记忆）',
  }
  // 用户之前在连接器面板里手动禁用过，就保留禁用状态，别给人家偷偷打开
  if (prev.disabled === true) cfg.mcpServers[MCP_MARK].disabled = true
  backup(MCP_FILE)
  writeFileSync(MCP_FILE, JSON.stringify(cfg, null, 2), 'utf8')
  log(`已注册 MCP server → ${MCP_FILE}（工具名 mcp__${MCP_MARK}__hedaren_pet）`)
  log(`MCP 运行时：${rt.exe}（来源 ${rt.source}${rt.version ? ' ' + rt.version : ''}）`)
  return true
}

/** 生成 config.json 模板（API Key 可选，不覆盖用户已填的） */
function ensureConfig() {
  const cfgFile = join(HERE, 'config.json')
  if (existsSync(cfgFile)) { log('config.json 已存在，保留用户配置'); return }
  const tpl = {
    _comment: '可选：填入任一 API Key 启用 AI 对话；留空则用本地人格话术（功能仍可用）',
    deepseekApiKey: '',
    arkApiKey: '',
    ARK_MODEL: 'deepseek-v3-1-250821',
 jailThreshold: 10,
  }
  writeFileSync(cfgFile, JSON.stringify(tpl, null, 2), 'utf8')
  log(`已生成配置模板 → ${cfgFile}`)
}

/** 把 Skill 装进 ~/.workbuddy/skills/hedaren-pet/，替换路径占位符 */
function installSkill() {
  const tplFile = join(HERE, 'skill-template', 'SKILL.md')
  if (!existsSync(tplFile)) { log('未找到 skill 模板，跳过 Skill 安装'); return }
  let md = readFileSync(tplFile, 'utf8')
  const wrapper = join(HERE, 'bin', platform() === 'win32' ? 'hedaren-node.cmd' : 'hedaren-node.sh')
  const rt = resolveRuntime()
  const replacements = {
    '{{PET_DIR}}': HERE,
    '{{STATE_DIR}}': STATE_DIR,
    // 给 Agent 抄的命令也走包装脚本：换机器、换 node 版本都不用改文档
    '{{NODE_EXE}}': existsSync(wrapper) ? wrapper : (rt ? rt.exe : process.execPath),
  }
  for (const [k, v] of Object.entries(replacements)) md = md.split(k).join(v)
  if (uninstall) {
    // 卸载时保留 skill（用户可手动删），仅提示
    log('Skill 保留在 ' + SKILL_DIR + '（如要彻底删除可手动移除）')
    return
  }
  try {
    mkdirSync(SKILL_DIR, { recursive: true })
    writeFileSync(join(SKILL_DIR, 'SKILL.md'), md, 'utf8')
    log(`已安装对话 Skill → ${join(SKILL_DIR, 'SKILL.md')}`)
  } catch (e) {
    log('Skill 安装失败：' + e.message)
  }
}

/** 启动桌宠窗口（detached，独立于本安装进程） */
function startPet(electronPath) {
  if (noStart || uninstall) return
  try {
    const env = { ...process.env, HEDAREN_PET_HOME: STATE_DIR }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    const child = spawn(electronPath, [join(HERE, 'app')], {
      stdio: 'ignore', windowsHide: false, env, detached: true,
    })
    child.unref()
    log(`桌宠窗口已启动 pid=${child.pid}`)
  } catch (e) {
    log('启动桌宠失败（可稍后运行 start 脚本）：' + e.message)
  }
}

async function main() {
  log('=== 和大人桌宠 · WorkBuddy 安装器 ===')

  if (uninstall) {
    mergeHooks()
    mergeMcp()
    log('卸载完成。桌宠文件本身保留，可手动删除目录。')
    return
  }

  // 1) Electron
  const electron = await ensureElectron({ forceDownload, onLog: (s) => log(s.replace(/^\[electron\]\s*/, '[electron] ')) })
  log(`Electron 就绪：${electron.path}（来源 ${electron.source}）`)

  // 2) 核心引擎自检
  await coreInit()
  log('核心引擎自检通过')

  // 3) 配置
  ensureConfig()
  mergeHooks()
  mergeMcp()
  installSkill()

  // 4) 启动
  startPet(electron.path)

  log('')
  log('✅ 安装完成！')
  log('   • 桌宠窗口：已启动（没起来就双击 start.bat）')
  log('   • 工作状态联动：已注册 hooks（需重启 WorkBuddy 生效）')
  log('   • 积分国库查询：已注册 MCP 工具 mcp__' + MCP_MARK + '__hedaren_pet')
  log('   • 跟和大人说话：用 WorkBuddy 当前会话模型，不用另配 API Key')
  log('   • 自动唤醒 / 守护进程：默认都关着，要开在府邸或托盘里点')
  log('   • 运行时：全部走 bin/hedaren-node 运行时探测，换机器不用改任何路径')
}

main().catch((e) => {
  console.error('[install] 失败：', e)
  process.exit(1)
})
