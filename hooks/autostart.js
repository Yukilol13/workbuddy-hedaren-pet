#!/usr/bin/env node
/**
 * 桌宠自动拉起器：由 hooks/pet-hook.js 在 SessionStart 事件时 fire-and-forget 调起。
 *
 * 判活逻辑：
 *   1. autostart.json { "enabled": false } → 不拉起（用户手动关闭）
 *   2. autostart.lock 60 秒内被别的拉起器写过 → 放弃（防抖，避免多会话同时拉）
 *   3. window.lock { pid, ts } 进程活着且心跳 < 30 秒 → 已在运行，不动
 *   4. 否则 → detached 启动 start.js（Electron 有单实例锁兜底，双开也无害）
 */
import { readFileSync, writeFileSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const PET_HOME = process.env.HEDAREN_PET_HOME || join(homedir(), '.workbuddy', 'hedaren-pet')
const PET_DIR = dirname(dirname(fileURLToPath(import.meta.url))) // hooks/ 的上一级 = 项目根
const autostartCfg = () => join(PET_HOME, 'autostart.json')
const autostartLock = () => join(PET_HOME, 'autostart.lock')
const windowLock = () => join(PET_HOME, 'window.lock')

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

const pidAlive = (pid) => {
  if (!pid || pid === process.pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

// 1) 用户开关
const cfg = readJson(autostartCfg())
if (cfg && cfg.enabled === false) process.exit(0)

// 2) 防抖：60 秒内已有拉起动作
const sent = readJson(autostartLock())
if (sent && Date.now() - (sent.ts || 0) < 60_000) process.exit(0)

// 3) 窗口心跳判活
const wl = readJson(windowLock())
if (wl && pidAlive(wl.pid) && Date.now() - (wl.ts || 0) < 30_000) process.exit(0)

// 4) 记录防抖标记并拉起
try {
  writeFileSync(autostartLock(), JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8')
} catch {}
try {
  const log = openSync(join(PET_HOME, 'autostart.log'), 'a')
  const child = spawn(
    process.execPath,
    [join(PET_DIR, 'start.js'), '--detached'],
    {
      detached: true,
      cwd: PET_DIR,
      stdio: ['ignore', log, log],
      env: { ...process.env, HEDAREN_PET_HOME: PET_HOME },
    },
  )
  child.unref()
} catch {
  process.exit(1)
}
