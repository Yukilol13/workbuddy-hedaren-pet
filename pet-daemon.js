#!/usr/bin/env node
/**
 * 和大人桌宠 · 常驻守护进程
 *
 * 复刻原 DSH 插件 index.js 里的 ctx.effect 轮询器。新版把逻辑拆成按需调用的
 * core.js 后丢了这块，导致「窗口里发消息收不到回复」。本进程专门补回：
 *   - 消费聊天窗口写入的 chat.pending  → core.answerChat 生成回复
 *   - 右键「记忆账本」memory.viewAt    → core.showLedger
 *   - 右键「查看国库」treasury.refreshAt → core.refreshTreasury
 *   - 定期自动刷新国库积分
 *   - 把可用模型列表同步进 state，供对话窗口下拉选择
 * 捕鱼相关轮询已随功能关闭一并移除。
 *
 * 单实例保护：用 stateDir/daemon.lock 记录 pid + 心跳，避免重复启动双轮询。
 */
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  init, readState, writeState, answerChat, showLedger,
  refreshTreasury, listModels, onLog, stateDir,
} from './core.js'

const LOCK_FILE = join(stateDir(), 'daemon.lock')
const POLL_MS = 800
const STALE_MS = 15000

function pidAlive(pid) {
  if (!pid || pid === process.pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

async function readLock() {
  try { return JSON.parse(await readFile(LOCK_FILE, 'utf8')) } catch { return null }
}

async function acquireLock() {
  const lock = await readLock()
  if (lock && Date.now() - (lock.ts || 0) < STALE_MS && pidAlive(lock.pid)) return false
  await mkdir(stateDir(), { recursive: true })
  await writeFile(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8')
  return true
}

async function touchLock() {
  try {
    const lock = await readLock()
    if (lock && lock.pid === process.pid) {
      await writeFile(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8')
    }
  } catch {}
}

async function releaseLock() {
  try {
    const lock = await readLock()
    if (lock && lock.pid === process.pid) await unlink(LOCK_FILE)
  } catch {}
}

/** 把可用模型列表写进 state.chat，供对话窗口渲染下拉 */
async function syncModels(log) {
  try {
    const models = await listModels()
    const s = await readState()
    const chat = { ...(s.chat || {}), models }
    // 避免用户已选的模型被重置；默认选中有 Key 的第一个（或配置里的 defaultModel）
    if (!chat.model || !models.some((m) => m.id === chat.model)) {
      const def = models.find((m) => m.isDefault && m.available) || models.find((m) => m.available) || models[0]
      chat.model = def ? def.id : ''
    }
    await writeState({ chat })
    log(`[daemon] 对话模型已同步：${models.map((m) => m.id + (m.available ? '✓' : '✗')).join(', ') || '（无，走本地话术）'}`)
  } catch (e) {
    log(`[daemon] 同步模型列表失败：${e.message}`)
  }
}

export async function startDaemon({ log = (s) => console.log(s) } = {}) {
  if (!(await acquireLock())) {
    log('[daemon] 已有守护进程在运行，跳过重复启动')
    return { started: false }
  }
  await init()
  onLog((s) => log(s))
  await syncModels(log)

  let pollBusy = false
  let lastChatPendingId = 0
  let lastMemoryViewAt = -1      // -1 = 首轮只记基线，不弹账本
  let lastTreasuryRefreshAt = 0
  let lastAutoCheck = Date.now()
  let lastLockTouch = Date.now()

  const timer = setInterval(async () => {
    if (pollBusy) return
    pollBusy = true
    try {
      const now = Date.now()
      if (now - lastLockTouch > 5000) { lastLockTouch = now; await touchLock() }
      const current = await readState()

      // 1) 对话回复
      const pending = current.chat?.pending
      if (pending && pending.id && Number(pending.id) !== lastChatPendingId) {
        lastChatPendingId = Number(pending.id)
        await answerChat(current, pending)
      }

      // 2) 记忆账本（右键菜单触发）
      const viewAt = Number(current.memory?.viewAt) || 0
      if (lastMemoryViewAt < 0) lastMemoryViewAt = viewAt
      else if (viewAt > lastMemoryViewAt) {
        lastMemoryViewAt = viewAt
        await showLedger(current)
      }

      // 3) 国库刷新（右键手动 / 30s 自动）
      const refreshAt = Number(current.treasury?.refreshAt) || 0
      if (refreshAt > lastTreasuryRefreshAt) {
        lastTreasuryRefreshAt = refreshAt
        await refreshTreasury({ manual: true })
      } else if (now - lastAutoCheck > 30000) {
        lastAutoCheck = now
        await refreshTreasury({ manual: false })
      }
    } catch (e) {
      log(`[daemon] 轮询异常：${e?.message || String(e)}`)
    } finally {
      pollBusy = false
    }
  }, POLL_MS)

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    releaseLock().catch(() => {})
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.on('exit', () => { clearInterval(timer) })

  log('[daemon] 守护进程已就绪（对话 / 账本 / 国库轮询）')
  return { started: true, stop }
}

// 直接执行：node pet-daemon.js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = await startDaemon()
  if (!r.started) process.exit(0)
}
