#!/usr/bin/env node
/**
 * 和大人桌宠 · 命令行控制器（Skill / 脚本直接调用）
 *
 * 用法：
 *   node hedarenctl.js say "皇上万岁" [动作名]
 *   node hedarenctl.js play "银票打手"
 *   node hedarenctl.js show | hide | status
 *   node hedarenctl.js work --task "写代码" --total 5 --done 2
 *   node hedarenctl.js idle
 *   node hedarenctl.js credits [--short]
 *   node hedarenctl.js chat-context "朕的国库如何"   # 取和大人上下文，供 WorkBuddy 模型写回复
 *   node hedarenctl.js reply "朕的国库如何" "回皇上的话"  # 写回 WorkBuddy 模型生成的回复
 *   node hedarenctl.js chat "朕的国库如何"           # 简写（无回复则本地话术兜底）
 *   node hedarenctl.js models       # 固定为 WorkBuddy 当前会话模型
 *   node hedarenctl.js memory | search "关键词"
 *   node hedarenctl.js mood | mood-reset       # 查/重置颤栗值与官位
 *   node hedarenctl.js fish-play [on|off]      # 捕鱼玩法开关（纯视觉）
 *   node hedarenctl.js mansion                # 打开和大人府邸设置窗口
 *   node hedarenctl.js daemon-start           # 手动启动守护进程（对话/账本/国库轮询）
 *   node hedarenctl.js daemon-stop            # 手动关闭守护进程
 *   node hedarenctl.js daemon-status          # 查看守护进程是否在运行
 *   node hedarenctl.js start        # 启动桌宠窗口（不再自动拉起守护进程）
 *   node hedarenctl.js install      # 一键安装
 */
import * as core from './core.js'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const a = process.argv.slice(2)
const cmd = (a[0] || 'status').toLowerCase()

function flag(name, def = undefined) {
  const i = a.indexOf('--' + name)
  return i >= 0 ? (a[i + 1] ?? true) : def
}

/** 读守护进程锁文件（STATE_DIR/daemon.lock：{pid, ts}） */
function readDaemonLock() {
  try {
    const lock = JSON.parse(readFileSync(join(core.stateDir(), 'daemon.lock'), 'utf8'))
    return lock && lock.pid ? lock : null
  } catch { return null }
}

function daemonPidAlive(pid) {
  if (!pid || pid === process.pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

await core.init()
let out

switch (cmd) {
  case 'say': {
    const text = a.slice(1).filter((x) => !x.startsWith('--')).join(' ')
    out = await core.say(text, flag('anim'), flag('face'))
    console.log(`和大人：${text}`)
    break
  }
  case 'play':
    out = await core.play(a[1] || '待机-呼吸', !a.includes('--once'))
    console.log(`动作：${a[1] || '待机-呼吸'}`)
    break
  case 'show': out = await core.show(); console.log('和大人现身'); break
  case 'hide': out = await core.hide(); console.log('和大人躲起来了'); break
  case 'status': {
    const s = await core.statusSummary()
    console.log(`可见：${s.visible ? '是' : '否'}`)
    console.log(`动作：${s.anim?.name || '待机'}`)
    if (s.say?.text) console.log(`台词：${s.say.text}`)
    console.log(`工作：${s.work?.active ? s.work.state + (s.work.task ? ' · ' + s.work.task : '') : '空闲'}`)
    console.log(`捕鱼：已关闭`)
    break
  }
  case 'work':
    out = await core.setWork({
      active: true, state: flag('approval') ? 'approval' : 'working',
      task: flag('task', ''), done: flag('done', 0), total: flag('total', 0),
      approval: flag('approval', ''),
    })
    console.log('工作状态已设置')
    break
  case 'idle':
    out = await core.setWork({ active: false })
    console.log('工作状态已清除')
    break
  case 'credits': {
    const r = await core.refreshTreasury({ manual: !a.includes('--no-say') })
    if (r.ok) {
      const { getCreditsReport } = await import('./credits.js')
      const rep = a.includes('--short') ? null : await getCreditsReport()
      if (rep) {
        console.log(`今日耗银：${rep.today} 积分`)
        console.log(`近七日：${rep.last7d} 积分`)
        console.log(`累计：${rep.total} 积分`)
      }
    } else console.log('国库查询失败：' + r.error)
    break
  }
  case 'chat-context': {
    const text = a.slice(1).filter((x) => !x.startsWith('--')).join(' ')
    const ctx = await core.chatContext(text)
    if (!ctx.ok) { console.log('取上下文失败：' + ctx.error); break }
    console.log('【和大人对话上下文 · 请 WorkBuddy 当前会话模型据此写回复】')
    console.log(ctx.instructions)
    if (ctx.history?.length) console.log('\n【最近对话】\n' + ctx.history.map((m) => `${m.role}: ${m.content}`).join('\n'))
    console.log('\n【皇上这句】' + ctx.text)
    if (ctx.dread) console.log('\n（此刻胆战心惊，只认错求饶）')
    console.log('\n' + ctx.note)
    break
  }
  case 'chat': {
    // 对话由 WorkBuddy 当前会话模型生成：优先用 --reply 提供的回复，否则本地话术兜底
    const text = a.slice(1).filter((x) => !x.startsWith('--') && x !== String(flag('reply', '\u0000'))).join(' ')
    const r = await core.chat(text, String(flag('reply', '')))
    console.log(`和大人${r.offline ? '（本地兜底话术）' : ''}：${r.reply}`)
    break
  }
  case 'reply': {
    const text = a[1] || ''
    const reply = a.slice(2).join(' ')
    const r = await core.submitReply(text, reply)
    console.log(`和大人${r.offline ? '（本地兜底话术）' : ''}：${r.reply}`)
    break
  }
  case 'models': {
    const models = await core.listModels()
    for (const m of models) console.log(`★ ${m.id} — ${m.label}（无需外部 Key）`)
    break
  }
  case 'set-model': {
    console.log('对话模型固定为 WorkBuddy 当前会话模型（无需切换，也不需要外部 Key）')
    break
  }
  case 'memory': {
    const cur = await core.readState()
    console.log(await core.showLedger(cur))
    break
  }
  case 'search': {
    const r = await core.memorySearch(a.slice(1).join(' '))
    console.log(`命中：${(r.picked || []).join('、') || '主记忆'}\n${r.text || ''}`)
    break
  }
  case 'mood': {
    const m = await core.moodView()
    console.log(`官位：${m.rankLabel} ｜ 颤栗值：${m.trembleLabel} ｜ 心气：${m.stateLabel}`)
    break
  }
  case 'mood-reset': {
    const m = await core.resetMood()
    console.log(`心气已归回原样（${m.rankLabel} / ${m.trembleLabel}）`)
    break
  }
  case 'fish-play': {
    const enabled = a[1] === undefined ? true : ['on', 'true', '1', '开'].includes(String(a[1]).toLowerCase())
    const on = await core.setFishPlay(enabled)
    console.log(`捕鱼玩法（纯视觉·一次性）已${on ? '开启（待触发，飞行满2秒捕一次后自动关闭）' : '关闭'}`)
    break
  }
  case 'mansion': {
    await core.writeState({ mansionOpenAt: Date.now() })
    console.log('已请求打开和大人府邸窗口')
    break
  }
  case 'start': {
    // 统一走 start.js：只拉起窗口，守护进程由用户手动启停（托盘或 daemon-start/daemon-stop）
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['--no-warnings', join(HERE, 'start.js')], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, HEDAREN_PET_HOME: process.env.HEDAREN_PET_HOME || join(homedir(), '.workbuddy', 'hedaren-pet') },
    })
    child.unref()
    console.log(`桌宠启动中 pid=${child.pid}（守护进程请手动开启：daemon-start 或托盘右键）`)
    break
  }
  case 'daemon-start': {
    const { spawn } = await import('node:child_process')
    const lock = readDaemonLock()
    if (lock && daemonPidAlive(lock.pid)) { console.log('守护进程已在运行，无需重复启动'); break }
    const logPath = join(core.stateDir(), 'daemon.log')
    const { openSync } = await import('node:fs')
    const logFd = openSync(logPath, 'a')
    const child = spawn(process.execPath, ['--no-warnings', join(HERE, 'pet-daemon.js')], {
      detached: true, stdio: ['ignore', logFd, logFd],
      env: { ...process.env, HEDAREN_PET_HOME: process.env.HEDAREN_PET_HOME || join(homedir(), '.workbuddy', 'hedaren-pet') },
    })
    child.unref()
    console.log(`守护进程启动中 pid=${child.pid}（对话 / 账本 / 国库轮询）`)
    break
  }
  case 'daemon-stop': {
    const lock = readDaemonLock()
    if (!lock || !daemonPidAlive(lock.pid)) { console.log('守护进程没有在运行'); break }
    try { process.kill(lock.pid); console.log(`守护进程已关闭（pid=${lock.pid}）`) }
    catch (e) { console.log('关闭失败：' + e.message) }
    break
  }
  case 'daemon-status': {
    const lock = readDaemonLock()
    const alive = lock && daemonPidAlive(lock.pid)
    console.log(alive ? `守护进程：运行中（pid=${lock.pid}）` : '守护进程：未运行（对话/账本/国库轮询不可用，WorkBuddy 对话不受影响）')
    break
  }
  case 'install': {
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync(process.execPath, ['--no-warnings', join(HERE, 'install.js'), ...a.slice(1)], {
      stdio: 'inherit', cwd: HERE,
    })
    process.exit(r.status ?? 0)
    break
  }
  default:
    console.log('未知命令：' + cmd)
    console.log('可用：say / play / show / hide / status / work / idle / credits / chat / memory / search / start / daemon-start / daemon-stop / daemon-status / install')
    process.exit(1)
}
