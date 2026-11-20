#!/usr/bin/env node
/**
 * 启动和大人桌宠（探测/复用 Electron，找不到自动下载）
 * 同时拉起常驻守护进程 pet-daemon.js：负责对话回复、账本、国库轮询。
 * 用法：node start.js [--force-download]
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { ensureElectron, spawnPet } from './electron-runtime.js'
import { init as coreInit } from './core.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const force = process.argv.includes('--force-download')
// --detached：父进程（如 SessionStart 自动拉起）会立刻退出，Electron 也要脱离进程树独立存活
const detached = process.argv.includes('--detached')

const electron = await ensureElectron({
  forceDownload: force,
  onLog: (s) => console.log(s),
})
console.log(`[start] Electron: ${electron.path} (${electron.source})`)
await coreInit()

const PET_HOME = process.env.HEDAREN_PET_HOME || join(homedir(), '.workbuddy', 'hedaren-pet')
const env = { HEDAREN_PET_HOME: PET_HOME }

// 1) 拉起窗口
const { child } = spawnPet(electron.path, join(HERE, 'app'), env, { detached })
console.log(`[start] 桌宠窗口已启动 pid=${child.pid}${detached ? '（detached）' : ''}`)
if (detached) {
  child.unref()
} else {
  child.on('exit', (code) => console.log(`[start] 窗口退出 code=${code}`))
}

// 2) 守护进程不再自动拉起：由用户自己启动/关闭
//    （托盘右键「守护进程：开启/关闭」，或 hedarenctl.js daemon-start / daemon-stop / daemon-status）
//    关掉时受影响的功能：桌面聊天窗离线输入回复、右键查国库/记忆账本、30 秒自动国库刷新与亏空判定。
//    WorkBuddy 对话链路（chat-context / reply）不走守护进程，不受影响。
