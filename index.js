/**
 * hedaren-desktop-pet —— 和大人独立桌面宠物
 *
 * 不依赖 dsh-pet：自己拉起一个透明 Electron 窗口，播放 C 版两头身 webm。
 * 插件负责状态与对话工具，窗口每 900ms 读一次 $DSH_HOME/hedaren-pet/desktop-state.json。
 * 和大人始终把用户当皇上（不需要切换扮演对象）。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUDGET, createMemoryStore, estimateTokens } from './memory.js'
import { createDshPetBridge } from './dshpet.js'

export const name = 'hedaren-desktop-pet'
export const inject = ['commands', 'credentials', 'connection']

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const APP_DIR = join(PLUGIN_DIR, 'app')
const PERSONA_FILE = join(PLUGIN_DIR, 'persona.md')
const IDLE = '待机-呼吸'
const BOW = '点击-拱手'

const LINES = {
  intro: [
    '皇上万岁万岁万万岁！奴才和珅，给您请安了。',
    '皇上圣明！奴才这条命都是皇上的。',
    '皇上您瞧，奴才给您寻了件好东西。',
  ],
  click: [
    '皇上圣明，奴才给您行礼了！',
    '奴才在呢，皇上有什么吩咐？',
    '皇上您一句话，奴才跑断腿也办妥。',
  ],
  talk: [
    '皇上，这官窑的瓶子，天底下可就这一件。',
    '皇上说得极是，奴才愚钝，奴才该死。',
    '奴才富可敌国，可那都是皇上的，奴才只是替皇上看着。',
  ],
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function statePath() {
  return join(dshHome(), 'hedaren-pet', 'desktop-state.json')
}

function defaultState() {
  return {
    version: 1,
    visible: true,
    say: null,
    anim: { id: 0, name: IDLE, loop: true },
    work: {
      active: false,
      state: 'idle',
      task: '',
      done: 0,
      total: 0,
      approval: '',
      sessionId: null,
      updatedAt: 0,
    },
    x: null,
    y: null,
  }
}

async function readState() {
  try {
    const raw = await readFile(statePath(), 'utf8')
    const parsed = JSON.parse(raw)
    const base = defaultState()
    return {
      ...base,
      ...parsed,
      anim: { ...base.anim, ...(parsed.anim || {}) },
      work: { ...base.work, ...(parsed.work || {}) },
    }
  } catch {
    return defaultState()
  }
}

async function writeState(patch) {
  const current = await readState()
  const next = {
    ...current,
    ...patch,
    anim: patch && patch.anim ? { ...current.anim, ...patch.anim } : current.anim,
    say: patch && Object.prototype.hasOwnProperty.call(patch, 'say') ? patch.say : current.say,
    work: patch && patch.work ? { ...current.work, ...patch.work } : current.work,
    updatedAt: Date.now(),
  }
  await mkdir(dirname(statePath()), { recursive: true })
  await writeFile(statePath(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)]
}

function electronPath() {
  const explicit = process.env.DSH_PET_ELECTRON_PATH
  if (explicit && existsSync(explicit)) return explicit
  const base = join(dshHome(), 'electron')
  // 三平台的 Electron 可执行文件位置不一样
  const candidates =
    process.platform === 'win32'
      ? [join(base, 'electron.exe')]
      : process.platform === 'darwin'
        ? [
            join(base, 'Electron.app', 'Contents', 'MacOS', 'Electron'),
            join(base, 'electron'),
          ]
        : [join(base, 'electron'), join(base, 'electron', 'electron')]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return candidates[0]
}

function spawnPet(log, extraEnv = {}) {
  const exe = electronPath()
  if (!existsSync(exe)) {
    log.warn?.(`[hedaren-pet] 找不到 Electron：${exe}（先启动一次 dsh-pet 让它下载，或设置 DSH_PET_ELECTRON_PATH）`)
    return undefined
  }
  const env = { ...process.env, DSH_HOME: dshHome(), ...extraEnv }
  // DSH 宿主进程带 ELECTRON_RUN_AS_NODE=1；不清掉的话 Electron 会当 Node 跑，窗口秒退。
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(exe, [APP_DIR], {
    stdio: 'ignore',
    windowsHide: false,
    env,
  })
  child.on('error', (error) => log.warn?.(`[hedaren-pet] 启动失败：${error.message}`))
  child.on('exit', (code) => log.info?.(`[hedaren-pet] 窗口退出 code=${code}`))
  log.info?.(`[hedaren-pet] 桌面窗口启动 pid=${child.pid}`)
  return child
}

function sessionIdOf(session) {
  return String(session?.header?.id ?? session?.id ?? 'unknown')
}

function taskFromTodos(event) {
  const todos = Array.isArray(event?.data?.todos) ? event.data.todos : []
  const total = todos.length
  const done = todos.filter((t) => t?.status === 'completed').length
  let current
  for (const t of todos) {
    if (t?.status === 'in_progress') current = t
  }
  if (!current) current = todos.find((t) => t?.status === 'pending')
  const content = String(current?.content ?? '').trim()
  return { task: content, done, total }
}

function toolTaskText(event) {
  const name = String(event?.data?.name ?? '').trim()
  let args = event?.data?.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      args = undefined
    }
  }
  const a = args && typeof args === 'object' ? args : {}
  for (const key of ['description', 'file_path', 'path', 'command', 'query', 'text', 'action', 'task']) {
    const value = a[key]
    if (typeof value === 'string' && value.trim() !== '') {
      const short = value.trim().replace(/^[A-Za-z]:\\[^\s]*[\\/]/, '')
      return `${name || '工具'}：${short.slice(0, 28)}`
    }
  }
  return name
}

function approvalText(event) {
  const name = String(event?.data?.toolName ?? event?.data?.name ?? '').trim()
  const reason = event?.data?.reason
  const text =
    typeof reason === 'string'
      ? reason
      : reason && typeof reason === 'object'
        ? String(reason.message ?? reason.kind ?? '')
        : ''
  return [name && `工具 ${name}`, text].filter(Boolean).join(' · ').slice(0, 80)
}

export function apply(ctx, rawConfig = {}) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const log = ctx.logger ?? console
  let child

  const state = () => readState()

  // ---------- 大肥鱼（dsh-pet）桥：位置、显示状态、关掉它 ----------
  const dshPet = createDshPetBridge({ ctx, dshHome: dshHome(), log })
  let lastFishTargetAt = 0
  let lastFishSign = null

  function publishFishTarget(target) {
    return writeState({
      dshpet: {
        ok: Boolean(target?.ok),
        visible: Boolean(target?.visible),
        reason: target?.reason || '',
        petId: target?.pet?.id || '',
        name: target?.pet?.name || '',
        display: target?.pet?.display || '',
        surface: target?.surface || '',
        rect: target?.rect || null,
        window: target?.window || null,
        helper: target?.helper || null,
        helpers: Array.isArray(target?.helpers) ? target.helpers : [],
        gate: target?.gate || null,
        dshWindow: target?.dshWindow || null,
        at: Date.now(),
      },
    })
  }

  async function refreshFishTarget({ force = false } = {}) {
    try {
      const target = await dshPet.target({ force })
      await publishFishTarget(target)
      lastFishTargetAt = Date.now()
      return target
    } catch (error) {
      log.warn?.(`[hedaren-pet] 大肥鱼定位失败：${error?.message || String(error)}`)
      return null
    }
  }

  // 工作状态：监听 DSH 会话事件，任务运行时播「掏出 → 点钞循环」，有审批时挂起提示。
  const sessions = new Map()
  let workTimer
  let lastWorkSignature = ''

  function currentWork() {
    const entries = [...sessions.entries()]
    const approval = entries.find(([, v]) => v.state === 'approval')
    const working = entries.find(([, v]) => v.state === 'working')
    const chosen = approval ?? working
    if (!chosen) {
      return {
        active: false,
        state: 'idle',
        task: '',
        done: 0,
        total: 0,
        approval: '',
        sessionId: null,
        updatedAt: Date.now(),
      }
    }
    const [sessionId, value] = chosen
    return {
      active: true,
      state: value.state,
      task: value.task || '',
      done: value.done || 0,
      total: value.total || 0,
      approval: value.approval || '',
      sessionId,
      updatedAt: Date.now(),
    }
  }

  function publishWork() {
    if (workTimer) clearTimeout(workTimer)
    workTimer = setTimeout(() => {
      const work = currentWork()
      const signature = JSON.stringify(work)
      if (signature === lastWorkSignature) return
      lastWorkSignature = signature
      void writeState({ work }).catch(() => {})
    }, 180)
    workTimer.unref?.()
  }

  ctx.effect(() => {
    if (typeof ctx.on !== 'function') {
      log.warn?.('[hedaren-pet] 当前上下文没有 session/event，工作状态联动未启用')
      return () => {}
    }
    const dispose = ctx.on('session/event', (session, event) => {
      const type = event?.type
      if (!type) return
      const sessionId = sessionIdOf(session)
      const entry = sessions.get(sessionId) ?? {
        state: 'working',
        task: '',
        done: 0,
        total: 0,
        approval: '',
      }

      if (type === 'turn/start') {
        entry.state = 'working'
        entry.task = ''
        entry.done = 0
        entry.total = 0
        entry.approval = ''
      } else if (type === 'todo/write') {
        const todo = taskFromTodos(event)
        entry.task = todo.task || entry.task
        entry.done = todo.done
        entry.total = todo.total
        if (entry.state !== 'approval') entry.state = 'working'
      } else if (type === 'tool/call') {
        if (entry.state !== 'approval') entry.state = 'working'
        if (!entry.task) entry.task = toolTaskText(event)
      } else if (type === 'approval/asked') {
        entry.state = 'approval'
        entry.approval = approvalText(event)
      } else if (type === 'tool/result') {
        if (entry.state !== 'approval') entry.state = 'working'
      } else if (type === 'turn/end') {
        sessions.delete(sessionId)
        publishWork()
        // 每轮结束象征性查一次国库：花掉的 token 折成钱，和大人顺手抽一笔
        setTimeout(() => {
          void refreshTreasury({ manual: false }).catch(() => {})
        }, 2500).unref?.()
        return
      } else {
        return
      }

      sessions.set(sessionId, entry)
      publishWork()
    })
    return () => {
      dispose()
      if (workTimer) clearTimeout(workTimer)
      sessions.clear()
    }
  }, 'hedaren-desktop-pet: 任务/审批监听')

  async function say(text, animName, face) {
    const patch = { say: { id: Date.now(), text: String(text || '') } }
    if (face) patch.say.face = face
    if (animName) patch.anim = { id: Date.now(), name: animName, loop: false }
    return writeState(patch)
  }

  async function play(animName, loop = true) {
    return writeState({ anim: { id: Date.now(), name: String(animName || IDLE), loop: loop !== false } })
  }

  // ---------- 亏空阈值（牢房）----------
  /** 没存过阈值时的默认值：余额低于 10 元就进牢房 */
  const DEFAULT_JAIL_THRESHOLD = 10
  const jailThresholdFile = join(dshHome(), 'hedaren-pet', 'jail-threshold.json')

  /** 读「亏空阈值」：余额低于它就让和大人进牢房。没设置过就用默认 10 元 */
  async function readJailThreshold() {
    try {
      const raw = JSON.parse(await readFile(jailThresholdFile, 'utf8'))
      const v = Number(raw?.value)
      if (!Number.isFinite(v) || v < 0.01 || v > 10000) return DEFAULT_JAIL_THRESHOLD
      return Math.round(v * 100) / 100
    } catch {
      return DEFAULT_JAIL_THRESHOLD
    }
  }

  const JAIL_LINE = '小月！莫愁！你们什么时候来救我啊！'
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  // ---------- 国库 / 和大人资产 ----------
  const treasuryFile = join(dshHome(), 'hedaren-pet', 'desktop-treasury.json')
  const treasury = {
    assets: 0,
    totalSiphoned: 0,
    lastBalance: null,
    lastBalanceAt: 0,
    history: [],
    fish: 0, // 网住的大肥鱼条数
    fishHistory: [],
  }
  let treasuryLoaded = false
  let lastAutoCheck = 0
  let lastManualRefresh = 0

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100
  }

  function money(n) {
    const v = Number(n)
    if (!Number.isFinite(v)) return '0.00 积分'
    return (
      v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
      ' 积分'
    )
  }

  async function loadTreasury() {
    if (treasuryLoaded) return
    treasuryLoaded = true
    try {
      const raw = JSON.parse(await readFile(treasuryFile, 'utf8'))
      if (raw && typeof raw === 'object') {
        treasury.assets = Number.isFinite(Number(raw.assets)) ? round2(raw.assets) : 0
        treasury.totalSiphoned = Number.isFinite(Number(raw.totalSiphoned))
          ? round2(raw.totalSiphoned)
          : 0
        treasury.lastBalance =
          raw.lastBalance === null || raw.lastBalance === undefined ? null : Number(raw.lastBalance)
        if (!Number.isFinite(treasury.lastBalance)) treasury.lastBalance = null
        treasury.lastBalanceAt = Number(raw.lastBalanceAt) || 0
        treasury.history = Array.isArray(raw.history) ? raw.history.slice(0, 50) : []
        treasury.fish = Number.isFinite(Number(raw.fish)) ? Math.max(0, Math.round(Number(raw.fish))) : 0
        treasury.fishHistory = Array.isArray(raw.fishHistory) ? raw.fishHistory.slice(0, 50) : []
      }
    } catch {}
  }

  async function saveTreasury() {
    try {
      await mkdir(dirname(treasuryFile), { recursive: true })
      await writeFile(treasuryFile, JSON.stringify(treasury, null, 2), 'utf8')
    } catch {}
  }

  /**
   * 窗口那侧把「撞上大肥鱼」的判定结果写进 state.fish，这里做后果：
   *   成功 → 关掉大肥鱼（POST /pet-display none）+ 和大人资产里的「大肥鱼」计数 +1
   *   失败 → 什么都不改（请罪/破口大骂的台词由窗口那侧播）
   */
  async function handleFishEvent(event, current) {
    const result = String(event?.result || '')
    const speed = Number(event?.speed) || 0
    if (result === 'success') {
      let hideInfo = null
      try {
        hideInfo = await dshPet.hide()
      } catch (error) {
        log.warn?.(`[hedaren-pet] 关闭大肥鱼失败：${error?.message || String(error)}`)
      }
      await loadTreasury()
      treasury.fish += 1
      treasury.fishHistory.unshift({
        at: Date.now(),
        speed: Math.round(speed),
        hidden: Boolean(hideInfo?.ok),
      })
      treasury.fishHistory = treasury.fishHistory.slice(0, 50)
      await saveTreasury()
      await writeState({
        treasury: {
          guoku: treasury.lastBalance,
          assets: treasury.assets,
          fish: treasury.fish,
          lastCut: 0,
          updatedAt: Date.now(),
        },
      })
      const lines = [
        `国库：${money(treasury.lastBalance)}`,
        `和大人资产：${money(treasury.assets)}`,
        `大肥鱼：${treasury.fish} 条（关进府里了）`,
      ]
      await say(lines.join('\n'), undefined, 'none')
      log.info?.(
        `[hedaren-pet] 网住大肥鱼 第 ${treasury.fish} 条 速度=${Math.round(speed)}px/s 关闭=${Boolean(hideInfo?.ok)}`,
      )
      await refreshFishTarget({ force: true })
    } else {
      log.info?.(`[hedaren-pet] 捕捉大肥鱼失败 result=${result} 速度=${Math.round(speed)}px/s`)
    }
    void current
  }

  function parseAccountBalance(snapshot) {
    if (!snapshot || snapshot.status !== 'ready') return null
    const wallets = [...(Array.isArray(snapshot.value) ? snapshot.value : [])]
    wallets.push(...(Array.isArray(snapshot.bonusWallets) ? snapshot.bonusWallets : []))
    const byCurrency = new Map()
    for (const raw of wallets) {
      if (!raw || typeof raw !== 'object') continue
      const currency = typeof raw.currency === 'string' && raw.currency ? raw.currency : 'CNY'
      const amount = Number(raw.balance)
      if (!Number.isFinite(amount)) continue
      byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + amount)
    }
    if (byCurrency.has('CNY')) return { currency: 'CNY', total: byCurrency.get('CNY') }
    const first = [...byCurrency.entries()][0]
    return first ? { currency: first[0], total: first[1] } : null
  }

  async function queryBalance() {
    try {
      const account = ctx.get('deepseekAccount', false)
      if (account && typeof account.getBalance === 'function') {
        const snapshot = await account.getBalance({
          version: '0.1.0',
          locale: 'zh-CN',
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        })
        const parsed = parseAccountBalance(snapshot)
        if (parsed) return parsed
      }
    } catch (error) {
      log.warn?.(`[hedaren-pet] 账号余额查询失败：${error?.message || String(error)}`)
    }
    try {
      const resolved = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
      const key = resolved?.value
      if (!key) return null
      const res = await fetch('https://api.deepseek.com/user/balance', {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) return null
      const payload = await res.json()
      const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : []
      const picked = infos.find((x) => x && x.currency === 'CNY') ?? infos[0]
      if (!picked) return null
      const total = Number(picked.total_balance)
      return Number.isFinite(total) ? { currency: picked.currency || 'CNY', total } : null
    } catch (error) {
      log.warn?.(`[hedaren-pet] 官方余额查询失败：${error?.message || String(error)}`)
      return null
    }
  }

  async function refreshTreasury({ manual = false } = {}) {
    await loadTreasury()
    const balance = await queryBalance()
    if (!balance) {
      if (manual) await say('国库账本暂时查不着……主子容奴才再瞧瞧。', '待机-捻须')
      return null
    }
    const previous = treasury.lastBalance
    let cut = 0
    if (!manual && previous !== null && Number.isFinite(previous) && balance.total < previous - 0.001) {
      const spent = round2(previous - balance.total)
      const rate = 0.03 + Math.random() * 0.09
      cut = round2(Math.min(spent, Math.max(0.01, spent * rate)))
      if (cut > 0) {
        treasury.assets = round2(treasury.assets + cut)
        treasury.totalSiphoned = round2(treasury.totalSiphoned + cut)
        treasury.history.unshift({
          at: Date.now(),
          spent,
          cut,
          balanceAfter: round2(balance.total),
          assetsAfter: treasury.assets,
        })
        treasury.history = treasury.history.slice(0, 50)
      }
    }
    treasury.lastBalance = round2(balance.total)
    treasury.lastBalanceAt = Date.now()
    await saveTreasury()
    await writeState({
      treasury: {
        guoku: treasury.lastBalance,
        assets: treasury.assets,
        lastCut: cut,
        updatedAt: Date.now(),
      },
    })
    if (manual || cut > 0) {
      const lines = [
        `国库：${money(balance.total)}`,
        `和大人资产：${money(treasury.assets)}`,
      ]
      if (treasury.fish > 0) lines.push(`大肥鱼：${treasury.fish} 条`)
      if (cut > 0) lines.push(`刚抽成：${money(cut)}（主子别声张）`)
      // 国库播报不带表情，多行显示
      await say(lines.join('\n'), undefined, 'none')
      if (manual) {
        const threshold = await readJailThreshold()
        const total = round2(balance.total)
        if (threshold > 0 && total < threshold) {
          // 国库先露个面，再换成囚犯形象高呼
          await writeState({
            jail: { at: Date.now(), until: Date.now() + 14000, balance: total, threshold },
          })
          await sleep(4200)
          await say(JAIL_LINE, undefined, '04-委屈')
          log.info?.(`[hedaren-pet] 余额 ${total} < 阈值 ${threshold}：进牢房并高呼`)
        } else {
          const cur = await readState()
          if (cur?.jail) await writeState({ jail: null })
        }
      }
    }
    return { guoku: treasury.lastBalance, assets: treasury.assets, cut }
  }

  // ---------- 对话：皇上 ↔ 和大人（人格 + 三层记忆） ----------
  const memoryStore = createMemoryStore({ root: join(dshHome(), 'hedaren-pet'), log })
  let personaCache
  async function loadPersona() {
    if (personaCache !== undefined) return personaCache
    try {
      personaCache = (await readFile(PERSONA_FILE, 'utf8')).trim()
    } catch (error) {
      log.warn?.(`[hedaren-pet] 读不到 persona.md：${error?.message || String(error)}`)
      personaCache =
        '你是和珅，称用户为皇上，自称奴才。口语、京腔、爱打算盘；先揣摩对方要什么，话不说死，给对方留台阶。'
    }
    return personaCache
  }

  const MEMORY_HINT =
    '以上是你的记忆（画像、目录、命中的分记忆）。用得上就自然带一句「奴才记得……」，用不上别硬提；记忆里没有的事，别编。'

  async function callChat(messages, maxTokens = 420) {
    const key = (await ctx.credentials.resolve('DEEPSEEK_API_KEY'))?.value
    if (key) {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-flash',
          messages,
          max_tokens: maxTokens,
          temperature: 1.15,
          stream: false,
        }),
        signal: AbortSignal.timeout(60000),
      })
      if (!res.ok) throw new Error(`chat HTTP ${res.status}`)
      const payload = await res.json()
      return String(payload?.choices?.[0]?.message?.content ?? '').trim()
    }
    const arkKey = (await ctx.credentials.resolve('ARKCLI_AGENT_PLAN_API_KEY'))?.value
    if (!arkKey) throw new Error('没有可用的模型密钥')
    const res = await fetch('https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${arkKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        messages,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(60000),
    })
    if (!res.ok) throw new Error(`chat HTTP ${res.status}`)
    const payload = await res.json()
    return String(payload?.choices?.[0]?.message?.content ?? '').trim()
  }

  /** 皇上问一句：人格 + 记忆（主记忆/目录/命中的分记忆）+ 最近对话 → 和大人回一句，然后记下来 */
  async function answerChat(current, pending) {
    const text = String(pending?.text ?? '').trim()
    if (!text) return
    const persona = await loadPersona()
    const personaTokens = estimateTokens(persona)
    let injected = { text: '', picked: [], used: { profile: 0, main: 0, catalog: 0, shard: 0 } }
    try {
      injected = await memoryStore.retrieve(text)
    } catch (error) {
      log.warn?.(`[hedaren-pet] 记忆检索失败：${error?.message || String(error)}`)
    }
    const system = [persona, injected.text, MEMORY_HINT].filter(Boolean).join('\n\n')
    const { messages: historyMessages, tokens: historyTokens } = memoryStore.historyForPrompt()

    let reply
    try {
      reply = await callChat(
        [{ role: 'system', content: system }, ...historyMessages, { role: 'user', content: text }],
        BUDGET.replyMaxTokens,
      )
    } catch (error) {
      log.warn?.(`[hedaren-pet] 对话失败：${error?.message || String(error)}`)
      reply = '（拱手）奴才这会儿脑子有点发木，皇上您再说一遍？'
    }
    if (!reply) reply = '（陪笑）奴才听着呢，皇上您尽管吩咐。'

    // 先记下来再回话：分类 → 小量进主记忆，量大了进分记忆
    let remembered = null
    try {
      remembered = await memoryStore.remember({ question: text, reply })
      await memoryStore.pushHistory('user', text)
      await memoryStore.pushHistory('assistant', reply)
      await memoryStore.recordTurn({
        personaTokens,
        injected,
        replyTokens: estimateTokens(reply),
        cat: remembered?.cat,
        where: remembered?.where,
      })
    } catch (error) {
      log.warn?.(`[hedaren-pet] 记忆写入失败：${error?.message || String(error)}`)
    }

    const promptTokens =
      personaTokens + injected.used.profile + injected.used.main + injected.used.catalog + injected.used.shard + historyTokens
    log.info?.(
      `[hedaren-pet] 对话 分类=${remembered?.cat || '?'} 存到=${remembered?.where === 'shard' ? remembered.shard : '主记忆'} ` +
        `注入=[${injected.picked.join(',') || '主记忆'}] prompt≈${promptTokens}t`,
    )

    const messages = [
      ...(Array.isArray(current.chat?.messages) ? current.chat.messages : []),
      { id: Date.now(), role: 'assistant', text: reply, at: Date.now() },
    ]
    await writeState({ chat: { ...(current.chat || {}), open: true, messages, pending: null } })
    await say(reply.length > 60 ? reply.slice(0, 58) + '…' : reply)
  }

  /** 记忆账本：写进聊天窗，顺便开窗 */
  async function showLedger(current) {
    let text
    try {
      text = memoryStore.ledger()
    } catch (error) {
      text = `（拱手）账本一时翻不开：${error?.message || String(error)}`
    }
    const messages = [
      ...(Array.isArray(current?.chat?.messages) ? current.chat.messages : []),
      { id: Date.now(), role: 'assistant', text, at: Date.now() },
    ]
    await writeState({ chat: { ...(current?.chat || {}), open: true, messages, pending: null } })
    return text
  }

  // 轮询窗口状态文件：窗口负责 UI，这里负责余额与对话。
  let pollBusy = false
  let lastChatPendingId = 0
  let lastTreasuryRefreshAt = 0
  let lastMemoryViewAt = -1 // -1 = 首次轮询只记基线，不弹账本

  ctx.effect(() => {
    let stopped = false
    const timer = setInterval(() => {
      if (stopped || pollBusy) return
      pollBusy = true
      Promise.resolve()
        .then(async () => {
          const current = await readState()
          const pending = current.chat?.pending
          if (pending && pending.id && Number(pending.id) !== lastChatPendingId) {
            lastChatPendingId = Number(pending.id)
            await answerChat(current, pending)
          }
          // 右键菜单「记忆账本」：把主记忆/目录/分记忆和 token 账目写进聊天窗
          const viewAt = Number(current.memory?.viewAt) || 0
          if (lastMemoryViewAt < 0) {
            lastMemoryViewAt = viewAt
          } else if (viewAt > lastMemoryViewAt) {
            lastMemoryViewAt = viewAt
            await showLedger(current)
          }
          const refreshAt = Number(current.treasury?.refreshAt) || 0
          if (refreshAt > lastTreasuryRefreshAt) {
            lastTreasuryRefreshAt = refreshAt
            await refreshTreasury({ manual: true })
          } else if (Date.now() - lastAutoCheck > 30000) {
            lastAutoCheck = Date.now()
            await refreshTreasury({ manual: false })
          }
          // 大肥鱼位置：两秒刷一次，写进 state 给窗口那侧做碰撞判定
          if (Date.now() - lastFishTargetAt > 2000) await refreshFishTarget()
          // 窗口那侧撞上大肥鱼后的判定结果
          const fishAt = Number(current.fish?.at) || 0
          const fishSign = `${fishAt}:${current.fish?.result || ''}`
          if (lastFishSign === null) {
            lastFishSign = fishSign
          } else if (fishAt && fishSign !== lastFishSign) {
            lastFishSign = fishSign
            await handleFishEvent(current.fish, current)
          }
        })
        .catch((error) => log.warn?.(`[hedaren-pet] 轮询失败：${error?.message || String(error)}`))
        .finally(() => {
          pollBusy = false
        })
    }, 800)
    timer.unref?.()
    void refreshTreasury({ manual: false }).catch(() => {})
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, 'hedaren-desktop-pet: 国库与对话轮询')

  ctx.effect(() => {
    // 把 dsh-pet 的接口凭据经环境变量交给窗口（与 dsh-pet 自己交给 Helper 的做法一致，不落盘），
    // 这样撞上大肥鱼时窗口那侧能立刻把它关掉，不用等插件轮询。
    let token = ''
    try {
      const conn = ctx.get?.('connection', false)
      if (conn && typeof conn.authenticatedUrl === 'function') {
        token = new URL(conn.authenticatedUrl(dshPet.origin)).searchParams.get('token') || ''
      }
    } catch (error) {
      log.warn?.(`[hedaren-pet] 取窗口侧凭据失败：${error?.message || String(error)}`)
    }
    child = spawnPet(log, {
      HEDAREN_DSHPET_ORIGIN: dshPet.origin,
      ...(token ? { HEDAREN_DSHPET_TOKEN: token } : {}),
    })
    void writeState({ visible: true }).catch(() => {})
    return () => {
      try {
        child?.kill()
      } catch {}
      child = undefined
    }
  }, 'hedaren-desktop-pet: 独立窗口')

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'hedaren',
        description: '叫回和大人桌宠（隐藏后重新显示）',
        handler: async () => {
          const line = pick(LINES.intro)
          await writeState({ visible: true, say: { id: Date.now(), text: line } })
          return { kind: 'success', text: `和大人回来了：${line}` }
        },
      }),
    'hedaren-desktop-pet: /hedaren command',
  )

  ctx.effect(() => {
    const tools = ctx.get('tools')
    if (!tools) return () => {}
    return tools.register({
      name: 'hedaren_pet',
      description:
        '控制和大人独立桌宠：让他说话、播放指定动作、显示或隐藏、模拟工作状态。动作名例如「待机-呼吸」「待机-牢房」「待机-捻须」「点击-拱手」「银票打手」「斗嘴」「递古董」「常服进门」「琉璃厂」「跪舔」「常服算账」「塞银票」「拍马屁」「被参一本」「府里数银」「工作-掏出」「工作-循环」「工作-收起」「工作-过渡」「甩飞」「网住大肥鱼」。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'say', 'play', 'show', 'hide', 'work', 'treasury', 'chat', 'memory', 'memory_search', 'fish', 'fish_hide', 'fish_show'],
            description:
              'status 查状态；say 说一句；play 播动作；show/hide 显示隐藏；work 模拟/清除工作状态；treasury 查国库；chat 以皇上身份和和大人说一句；memory 看记忆账本；memory_search 按 query 试检索记忆；fish 看大肥鱼定位与最近一次捕捉；fish_hide/fish_show 关闭或恢复大肥鱼（调试用）。',
          },
          text: { type: 'string', description: 'action=say 时的台词。' },
          query: { type: 'string', description: 'action=memory_search 时：要检索的问题，例如「我追的姑娘不理我」。' },
          anim: { type: 'string', description: 'action=play 时的动作名，例如 银票打手。' },
          loop: { type: 'boolean', description: 'action=play 是否循环，默认 true。' },
          active: { type: 'boolean', description: 'action=work 时：是否处于工作状态。' },
          task: { type: 'string', description: 'action=work 时的任务文案。' },
          approval: { type: 'string', description: 'action=work 时的审批提示文案。' },
          done: { type: 'integer', description: 'action=work 时已完成步骤数。' },
          total: { type: 'integer', description: 'action=work 时总步骤数。' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => {
          const action = String(args?.action || 'status')
          let text = '和大人桌宠没有响应。'
          if (value && value.ok) {
            if (action === 'treasury' && value.treasury) {
              text = `国库：${money(value.treasury.guoku)}\n和大人资产：${money(value.treasury.assets)}`
            } else if (action === 'chat') {
              const last = [...(value.chat?.messages || [])].reverse().find((m) => m.role === 'assistant')
              text = `和大人：${value.reply || last?.text || '（拱手）奴才在。'}`
            } else if (action === 'memory') {
              text = value.ledger || '（拱手）账本一时翻不开。'
            } else if (action === 'memory_search') {
              text =
                `命中分记忆：${(value.picked || []).join('、') || '（没命中，走主记忆）'}\n` +
                `注入约 ${value.tokens || 0} tokens\n\n${value.text || ''}`
            } else if (action === 'fish') {
              const t = value.target || {}
              const pets = value.petState?.state?.pets
              const live = pets && typeof pets === 'object' ? pets : {}
              const pos = Object.keys(live).join(',')
              text =
                `大肥鱼：${t.ok ? (t.visible ? (t.surface === 'desktop' ? '在桌面窗口里' : '在网页里') : '不在显示范围') : `定位失败（${t.reason || '未知'}）`}\n` +
                `框：${t.rect ? `${t.rect.x},${t.rect.y} ${t.rect.w}×${t.rect.h}` : '无'}\n` +
                `DSH 窗口：${t.window ? `${t.window.x},${t.window.y} ${t.window.w}×${t.window.h} dpi=${t.window.dpi}` : '无'}\n` +
                `接口状态：${value.petState?.status || '无'}（宿主内部路由，不走 HTTP 鉴权）· pets=${pos || '无'}\n` +
                `接口凭据：${(value.auth?.attempts || []).join(' ')}（401 时走改配置文件的退路）\n` +
                `桌面窗口：${(Array.isArray(t.helpers) ? t.helpers : []).length} 个（dsh-pet helper）\n` +
                `像素判定：${
                  value.detect
                    ? `${value.detect.present ? '看见大肥鱼' : '槽位里没有大肥鱼'}（hits=${value.detect.hits}${
                        (Array.isArray(value.detect.slots) && value.detect.slots.length
                          ? ` · ${value.detect.slots.map((x) => `${x.from === 'page' ? '网页' : '桌面'} ${x.x},${x.y} ${x.w}x${x.h}`).join(' + ')}`
                          : value.detect.rect
                            ? ` · 框 ${value.detect.rect.x},${value.detect.rect.y} ${value.detect.rect.w}x${value.detect.rect.h}`
                            : '')
                      }）${value.detect.everSeen ? '·本轮见过' : '·本轮没见过（按配置算可见）'}`
                    : '还没测过'
                }\n` +
                `已网住：${value.treasuryFish || 0} 条`
            } else if (action === 'fish_hide' || action === 'fish_show') {
              text = `${action === 'fish_hide' ? '关闭' : '恢复'}大肥鱼：${value.ok ? '成功' : '失败'}`
            } else {
              text = `和大人：${value.anim?.name || '待机'}${value.say?.text ? ` · “${value.say.text}”` : ''}`
            }
          }
          return [{ type: 'text', text }]
        },
      },
      async execute(args) {
        const action = String(args?.action || 'status')
        try {
          if (action === 'say') {
            const next = await say(args?.text, args?.anim)
            return { ok: true, ...next }
          }
          if (action === 'play') {
            const next = await play(args?.anim, args?.loop !== false)
            return { ok: true, ...next }
          }
          if (action === 'work') {
            const active = args?.active === true
            const next = await writeState({
              work: {
                active,
                state: active ? (args?.approval ? 'approval' : 'working') : 'idle',
                task: String(args?.task ?? ''),
                done: Number(args?.done ?? 0) || 0,
                total: Number(args?.total ?? 0) || 0,
                approval: String(args?.approval ?? ''),
                sessionId: active ? 'manual' : null,
                updatedAt: Date.now(),
              },
            })
            return { ok: true, ...next }
          }
          if (action === 'treasury') {
            const result = await refreshTreasury({ manual: true })
            return { ok: Boolean(result), treasury: result }
          }
          if (action === 'chat') {
            const text = String(args?.text || '').trim()
            if (!text) return { ok: false, error: 'chat 需要 text' }
            const current = await readState()
            const now = Date.now()
            const messages = [
              ...(Array.isArray(current.chat?.messages) ? current.chat.messages : []),
              { id: now, role: 'user', text, at: now },
            ]
            await writeState({
              chat: { ...(current.chat || {}), open: true, messages, pending: { id: now + 1, text } },
            })
            await answerChat(await readState(), { id: now + 1, text })
            const after = await readState()
            const reply = [...(after.chat?.messages || [])].reverse().find((m) => m.role === 'assistant')
            return { ok: true, reply: reply?.text || '', chat: after.chat }
          }
          if (action === 'memory') {
            const current = await readState()
            const text = await showLedger(current)
            return { ok: true, ledger: text, snapshot: memoryStore.snapshot() }
          }
          if (action === 'memory_search') {
            const query = String(args?.query || args?.text || '').trim()
            if (!query) return { ok: false, error: 'memory_search 需要 query' }
            const hit = await memoryStore.retrieve(query)
            return {
              ok: true,
              query,
              picked: hit.picked,
              tokens: hit.used.profile + hit.used.main + hit.used.catalog + hit.used.shard,
              used: hit.used,
              text: hit.text,
            }
          }
          if (action === 'fish') {
            const target = await refreshFishTarget({ force: true })
            await loadTreasury()
            const snap = await dshPet.petState().catch(() => null)
            const auth = await dshPet.probeAuth().catch(() => null)
            const current = await readState()
            return { ok: Boolean(target?.ok), target, treasuryFish: treasury.fish, petState: snap, auth, detect: current.fishDetect || null }
          }
          if (action === 'fish_hide') {
            const result = await dshPet.hide()
            await refreshFishTarget({ force: true })
            return { ok: Boolean(result.ok), hide: result }
          }
          if (action === 'fish_show') {
            // 恢复成 both：桌面上要有她，捕鱼才有目标
            const result = await dshPet.show('both')
            await refreshFishTarget({ force: true })
            return { ok: Boolean(result.ok), show: result }
          }
          if (action === 'show' || action === 'hide') {
            const next = await writeState({ visible: action === 'show' })
            return { ok: true, ...next }
          }
          return { ok: true, ...(await state()) }
        } catch (error) {
          return { ok: false, error: error?.message || String(error) }
        }
      },
    })
  }, 'hedaren-desktop-pet: 对话工具')

  log.info?.('[hedaren-pet] 独立桌宠插件已加载')
}
