#!/usr/bin/env node
/**
 * 和大人桌宠 · WorkBuddy 工作状态 Hook 桥
 *
 * WorkBuddy 每次触发 hook 会启动本脚本一次，事件 JSON 从 stdin 传入。
 * 由于每次调用是独立短进程，我们用 work-sessions.json 持久化"会话→工作状态"映射，
 * 复刻原 DSH 插件 ctx.on('session/event') 的多会话编排（审批 > 工作中 优先级）。
 *
 * 事件映射（WorkBuddy hook → 原 DSH 语义 → 桌宠 work.state）：
 *   SessionStart      → 初始化            → idle
 *   UserPromptSubmit  → turn/start        → working（清空任务）
 *   PreToolUse        → tool/call         → working（任务=工具描述）
 *   PostToolUse       → tool/result       → working
 *   Notification      → approval/asked    → approval（权限确认挂起提示）
 *   Stop              → turn/end          → idle（清除该会话）
 *   SessionEnd        → turn/end          → idle（清除该会话）
 */

import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

function stateDir() {
  return process.env.HEDAREN_PET_HOME || join(homedir(), '.workbuddy', 'hedaren-pet')
}
const sessionsFile = () => join(stateDir(), 'work-sessions.json')
const stateFile = () => join(stateDir(), 'desktop-state.json')

// ---------- 读取 stdin（hook 事件） ----------
async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}

// ---------- 会话持久化 ----------
async function readSessions() {
  try {
    const o = JSON.parse(await readFile(sessionsFile(), 'utf8'))
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch {
    return {}
  }
}
async function writeSessions(obj) {
  await mkdir(stateDir(), { recursive: true })
  await writeFile(sessionsFile(), JSON.stringify(obj, null, 2), 'utf8')
}

// ---------- 从事件提取文案 ----------
function toolTaskText(event) {
  const name = String(event?.tool_name || '').trim()
  let input = event?.tool_input
  if (typeof input === 'string') {
    try { input = JSON.parse(input) } catch { input = undefined }
  }
  const a = input && typeof input === 'object' ? input : {}
  for (const key of ['description', 'file_path', 'path', 'command', 'query', 'text', 'action', 'task', 'pattern']) {
    const value = a[key]
    if (typeof value === 'string' && value.trim() !== '') {
      const short = value.trim().replace(/^[A-Za-z]:\\[^\s]*[\\/]/, '')
      return `${name || '工具'}：${short.slice(0, 28)}`
    }
  }
  return name || '工具调用'
}

function approvalText(event) {
  const name = String(event?.tool_name || '').trim()
  const reason = event?.reason || event?.message || ''
  const text = typeof reason === 'string' ? reason : String(reason?.message ?? reason?.kind ?? '')
  return [name && `工具 ${name}`, text].filter(Boolean).join(' · ').slice(0, 80)
}

// ---------- 计算当前工作态（复刻 original currentWork） ----------
// 会话过期时间：hook 短进程若被强杀可能漏发 Stop，残留 working 会遮住真实会话。
// 超过该时间未更新的会话视为失效（5 分钟）。
const SESSION_TTL_MS = 5 * 60 * 1000

function currentWork(sessions) {
  const now = Date.now()
  const fresh = Object.entries(sessions).filter(([, v]) => {
    const t = Number(v?.updatedAt) || 0
    return !t || now - t < SESSION_TTL_MS
  })
  const entries = fresh
  const approval = entries.find(([, v]) => v.state === 'approval')
  const working = entries.find(([, v]) => v.state === 'working')
  const chosen = approval ?? working
  if (!chosen) {
    return { active: false, state: 'idle', task: '', done: 0, total: 0, approval: '', sessionId: null, updatedAt: Date.now() }
  }
  const [sessionId, value] = chosen
  return {
    active: true, state: value.state, task: value.task || '',
    done: value.done || 0, total: value.total || 0, approval: value.approval || '',
    sessionId, updatedAt: Date.now(),
  }
}

async function writeWork(work) {
  let current = {}
  try { current = JSON.parse(await readFile(stateFile(), 'utf8')) } catch {}
  const next = { ...current, work, updatedAt: Date.now() }
  await mkdir(stateDir(), { recursive: true })
  await writeFile(stateFile(), JSON.stringify(next, null, 2), 'utf8')
}

async function main() {
  const event = await readStdin()
  const argEvent = (() => {
    const i = process.argv.indexOf('--event')
    return i >= 0 ? process.argv[i + 1] : ''
  })()
  const hook = String(event.hook_event_name || argEvent || '')
  const sessionId = String(event.session_id || event.sessionId || 'default')
  const sessions = await readSessions()
  let changed = true

  // 顺手清理过期会话，防止残留 working 长期占用
  const now = Date.now()
  for (const [sid, v] of Object.entries(sessions)) {
    const t = Number(v?.updatedAt) || 0
    if (t && now - t > SESSION_TTL_MS) delete sessions[sid]
  }

  if (hook === 'SessionStart') {
    delete sessions[sessionId]
    // 绑定启动：随 WorkBuddy 会话自动拉起桌宠（fire-and-forget，不阻塞 hook）。
    // autostart.js 内部有判活 + 防抖，已运行/开关关闭时秒退。
    try {
      const PET_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
      const child = spawn(process.execPath, [join(PET_DIR, 'hooks', 'autostart.js')], {
        detached: true,
        cwd: PET_DIR,
        stdio: 'ignore',
        env: process.env,
      })
      child.unref()
    } catch {}
  } else if (hook === 'UserPromptSubmit') {
    sessions[sessionId] = { state: 'working', task: '', done: 0, total: 0, approval: '', updatedAt: Date.now() }
  } else if (hook === 'PreToolUse') {
    const e = sessions[sessionId] ?? { state: 'working', task: '', done: 0, total: 0, approval: '' }
    if (e.state !== 'approval') e.state = 'working'
    if (!e.task) e.task = toolTaskText(event)
    e.updatedAt = Date.now()
    sessions[sessionId] = e
  } else if (hook === 'PostToolUse') {
    const e = sessions[sessionId] ?? { state: 'working', task: '', done: 0, total: 0, approval: '' }
    if (e.state !== 'approval') e.state = 'working'
    e.done = (e.done || 0) + 1
    e.updatedAt = Date.now()
    sessions[sessionId] = e
  } else if (hook === 'Notification') {
    // 权限确认 / 通知：作为审批挂起
    const source = String(event.source || '')
    if (source === 'permission_prompt' || /permission|确认|授权/i.test(source + ' ' + String(event.message || ''))) {
      const e = sessions[sessionId] ?? { state: 'working', task: '', done: 0, total: 0, approval: '' }
      e.state = 'approval'
      e.approval = approvalText(event)
      e.updatedAt = Date.now()
      sessions[sessionId] = e
    } else {
      changed = false
    }
  } else if (hook === 'Stop' || hook === 'SessionEnd') {
    delete sessions[sessionId]
  } else {
    changed = false
  }

  if (changed) {
    await writeSessions(sessions)
    await writeWork(currentWork(sessions))
  }
  // Hook 约定：stdout 可空；非零退出仅用于阻断，这里永远放行
  process.stdout.write('')
}

main().catch(() => process.stdout.write(''))
