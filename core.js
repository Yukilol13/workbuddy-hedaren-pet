/**
 * 和大人桌宠 · WorkBuddy 通用核心引擎
 *
 * 由原 DSH 插件 index.js 改写而来，功能完全复刻，去除全部 DSH ctx 依赖：
 *   - 工作状态：由 hook 桥写入 state.work（不再监听 ctx.on('session/event')）
 *   - 国库/积分：读 WorkBuddy 本地数据库（credits.js），不再查 DeepSeek 余额
 *   - 对话：统一调用 WorkBuddy 当前会话模型（Agent 直接生成回复），
 *          复用 persona.md + memory.js 三层记忆 + 颤栗值；绝不再调用任何外部大模型 API。
 *          只有在拿不到 Agent 回复时（如桌面聊天窗离线输入）才用本地人格话术兜底。
 *   - 捕鱼：全部注释掉（FISH_ENABLED=false）
 *
 * 纯文件驱动：所有交互通过 desktop-state.json 完成，Electron 窗口与 MCP server 共享。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createMemoryStore, estimateTokens } from './memory.js'
import { getCreditsReport, shortText as creditsShort } from './credits.js'
import {
  parseRankCommand, toneBand, rankLabel, createMoodState,
  classify, applyTurn, directiveFor, forcedReply, publicView,
} from './mood.js'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const PERSONA_FILE = join(PLUGIN_DIR, 'persona.md')

// 捕鱼功能开关：按用户要求先注释/关闭
export const FISH_ENABLED = false

const IDLE = '待机-呼吸'

// 胆战心惊状态下的固定话术：认错求饶，不走模型也不弹气泡
const DREAD_LINES = [
  '（趴在地上直哆嗦）奴才该死！奴才该死！求皇上开恩，饶奴才这条狗命……',
  '（声音打颤）皇上息怒，都是奴才的错，奴才再也不敢了，求皇上宽恕……',
  '（连连磕头）奴才认罪，奴才万死，只求皇上开恩，别把奴才赶出去……',
]

export function stateDir() {
  return process.env.HEDAREN_PET_HOME || join(homedir(), '.workbuddy', 'hedaren-pet')
}
export function statePath() {
  return join(stateDir(), 'desktop-state.json')
}
function treasuryPath() {
  return join(stateDir(), 'desktop-treasury.json')
}
function jailThresholdPath() {
  return join(stateDir(), 'jail-threshold.json')
}
function moodPath() {
  return join(stateDir(), 'mood.json')
}
function fishPlayPath() {
  return join(stateDir(), 'fish-play.json')
}

// ---- 捕鱼玩法开关（纯视觉）：app/main.js 与 MCP 共用 fish-play.json ----
export async function readFishPlay() {
  // 一次性玩法：默认关闭，需右键手动开启；触发一次后由主进程写回 enabled=false
  try { return JSON.parse(await readFile(fishPlayPath(), 'utf8')).enabled === true }
  catch { return false }
}
export async function setFishPlay(enabled) {
  await mkdir(dirname(fishPlayPath()), { recursive: true })
  await writeFile(fishPlayPath(), JSON.stringify({ enabled: Boolean(enabled) }, null, 2), 'utf8')
  return Boolean(enabled)
}

// ---- 颤栗值 / 官位（mood.js 纯逻辑，落盘到本地 mood.json）----
export async function loadMood() {
  try {
    return createMoodState(JSON.parse(await readFile(moodPath(), 'utf8')))
  } catch {
    return createMoodState({})
  }
}
export async function saveMood(mood) {
  await mkdir(dirname(moodPath()), { recursive: true })
  await writeFile(moodPath(), JSON.stringify(mood, null, 2), 'utf8')
}
export async function resetMood() {
  const fresh = createMoodState({})
  await saveMood(fresh)
  return publicView(fresh)
}
export async function moodView() {
  return publicView(await loadMood())
}

export const LINES = {
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
  offline: [
    '（拱手）皇上，奴才这会儿脑子有点发木，您再说一遍？',
    '（陪笑）奴才听着呢，皇上您尽管吩咐。',
    '皇上圣明，这事奴才记下了，容奴才慢慢办。',
    '（捻须）皇上问得深，奴才得翻翻账本才敢答。',
  ],
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)]
}
export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100
}
function money(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '0.00'
  return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function defaultState() {
  return {
    version: 1,
    visible: true,
    say: null,
    anim: { id: 0, name: IDLE, loop: true },
    work: {
      active: false, state: 'idle', task: '', done: 0, total: 0,
      approval: '', sessionId: null, updatedAt: 0,
    },
    scale: 1,
    throwSettleMs: 200,
    jailThreshold: 10,
    x: null,
    y: null,
  }
}

export async function readState() {
  try {
    const parsed = JSON.parse(await readFile(statePath(), 'utf8'))
    const base = defaultState()
    return {
      ...base, ...parsed,
      anim: { ...base.anim, ...(parsed.anim || {}) },
      work: { ...base.work, ...(parsed.work || {}) },
    }
  } catch {
    return defaultState()
  }
}

export async function writeState(patch) {
  const current = await readState()
  const next = {
    ...current,
    ...patch,
    anim: patch?.anim ? { ...current.anim, ...patch.anim } : current.anim,
    say: patch && Object.prototype.hasOwnProperty.call(patch, 'say') ? patch.say : current.say,
    work: patch?.work ? { ...current.work, ...patch.work } : current.work,
    updatedAt: Date.now(),
  }
  await mkdir(dirname(statePath()), { recursive: true })
  await writeFile(statePath(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

// ---------------- 对话模型：统一使用 WorkBuddy 当前会话模型（Agent 直接回复） ----------------
// 桌宠本身不再调用任何外部大模型 API（DeepSeek / 火山方舟 / OpenAI 等）。
// 对话由 WorkBuddy 会话中的 Agent 按 persona.md + 三层记忆 + 颤栗值生成，
// 再通过 MCP / hedarenctl.js 的 reply 动作写回（core.chat / core.submitReply）。
// 只有桌面聊天窗在拿不到 Agent 回复时，才用本地人格话术兜底。

/** 供 UI / MCP 展示：只有一个「模型」——WorkBuddy 当前会话 */
export async function listModels() {
  return [{
    id: 'workbuddy',
    label: 'WorkBuddy 当前会话模型',
    provider: 'workbuddy',
    model: 'current-session',
    available: true,
    isDefault: true,
  }]
}

/** 兼容旧引用：不再有外部 Key 概念 */
export async function hasApiKey() { return true }

const loggers = []
export function onLog(fn) { loggers.push(fn); return () => { const i = loggers.indexOf(fn); if (i >= 0) loggers.splice(i, 1) } }
function log(msg) { for (const fn of loggers) { try { fn(msg) } catch {} } }

// ---------------- 国库（积分）与和大人资产 ----------------
const DEFAULT_JAIL_THRESHOLD = 10
const treasury = {
  assets: 0, totalSiphoned: 0, lastBalance: null, lastBalanceAt: 0,
  history: [], fish: 0, fishHistory: [], lastJailDay: null,
}
let treasuryLoaded = false

async function loadTreasury() {
  if (treasuryLoaded) return
  treasuryLoaded = true
  try {
    const raw = JSON.parse(await readFile(treasuryPath(), 'utf8'))
    if (raw && typeof raw === 'object') {
      treasury.assets = Number.isFinite(Number(raw.assets)) ? round2(raw.assets) : 0
      treasury.totalSiphoned = Number.isFinite(Number(raw.totalSiphoned)) ? round2(raw.totalSiphoned) : 0
      treasury.lastBalance = raw.lastBalance == null ? null : Number(raw.lastBalance)
      if (!Number.isFinite(treasury.lastBalance)) treasury.lastBalance = null
      treasury.lastBalanceAt = Number(raw.lastBalanceAt) || 0
      treasury.history = Array.isArray(raw.history) ? raw.history.slice(0, 50) : []
      treasury.fish = Number.isFinite(Number(raw.fish)) ? Math.max(0, Math.round(Number(raw.fish))) : 0
      treasury.fishHistory = Array.isArray(raw.fishHistory) ? raw.fishHistory.slice(0, 50) : []
      treasury.lastJailDay = typeof raw.lastJailDay === 'string' ? raw.lastJailDay : null
    }
  } catch {}
}

async function saveTreasury() {
  try {
    await mkdir(dirname(treasuryPath()), { recursive: true })
    await writeFile(treasuryPath(), JSON.stringify(treasury, null, 2), 'utf8')
  } catch {}
}

export async function readJailThreshold() {
  try {
    const raw = JSON.parse(await readFile(jailThresholdPath(), 'utf8'))
    const v = Number(raw?.value)
    if (!Number.isFinite(v) || v < 0.01 || v > 1e9) return DEFAULT_JAIL_THRESHOLD
    return Math.round(v * 100) / 100
  } catch {
    return DEFAULT_JAIL_THRESHOLD
  }
}

export async function writeJailThreshold(value) {
  const v = Number(value)
  if (!Number.isFinite(v)) return false
  try {
    await mkdir(dirname(jailThresholdPath()), { recursive: true })
    await writeFile(jailThresholdPath(), JSON.stringify({ value: round2(v), updatedAt: Date.now() }, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 刷新国库：读积分消耗。WorkBuddy 的积分是"已消耗量"而非"余额"，
 * 因此抽成逻辑改为：本轮新增消耗的部分，和大人按比例抽一笔进自己小金库（纯娱乐）。
 */
export async function refreshTreasury({ manual = false, log: _log = log } = {}) {
  await loadTreasury()
  const rep = await getCreditsReport()
  if (!rep.ok) {
    if (manual) await say('国库账本暂时查不着……主子容奴才再瞧瞧。', '待机-捻须')
    return { ok: false, error: rep.error }
  }
  const total = round2(rep.total)
  const previous = treasury.lastBalance
  let cut = 0
  if (!manual && previous !== null && Number.isFinite(previous) && total > previous + 0.001) {
    const spent = round2(total - previous)
    const rate = 0.03 + Math.random() * 0.09
    cut = round2(Math.min(spent, Math.max(0.01, spent * rate)))
    if (cut > 0) {
      treasury.assets = round2(treasury.assets + cut)
      treasury.totalSiphoned = round2(treasury.totalSiphoned + cut)
      treasury.history.unshift({
        at: Date.now(), spent, cut,
        balanceAfter: total, assetsAfter: treasury.assets,
      })
      treasury.history = treasury.history.slice(0, 50)
    }
  }
  treasury.lastBalance = total
  treasury.lastBalanceAt = Date.now()
  await saveTreasury()
  await writeState({
    treasury: {
      guoku: total,
      assets: treasury.assets,
      lastCut: cut,
      report: {
        today: rep.today, last7d: rep.last7d, total: rep.total,
        tokens: rep.tokens, sessions: rep.sessions, lastSession: rep.lastSession,
        days: rep.days, updatedAt: rep.updatedAt,
      },
      updatedAt: Date.now(),
    },
  })

  if (manual || cut > 0) {
    const lines = [
      `今日耗银：${rep.today} 积分`,
      `近七日：${rep.last7d} 积分`,
      `国库总余额：${money(total)} 积分`,
      `和大人小金库：${money(treasury.assets)} 积分`,
    ]
    if (cut > 0) lines.push(`刚抽成：${round2(cut)} 积分（主子别声张）`)
    await say(lines.join('\n'), undefined, 'none')
  }

  // 亏空（肚兜坐牢）判定：当日消耗额超过阈值（积分）→ 触发肚兜形态 + 喊小月莫愁。
  // 每天最多触发一次；阈值 0 = 不判定。daemon 每 30 秒刷新一次国库，触发最迟滞后 30 秒。
  {
    const threshold = await readJailThreshold()
    const now = new Date()
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    if (threshold > 0 && Number(rep.today) > threshold && treasury.lastJailDay !== todayKey) {
      treasury.lastJailDay = todayKey
      await saveTreasury()
      await writeState({
        jail: { at: Date.now(), until: Date.now() + 14000, today: rep.today, threshold },
      })
      await new Promise((r) => setTimeout(r, 4200)) // 先让肚兜形象亮几秒，再喊话
      await say(
        `小月！莫愁！今日烧了 ${rep.today} 积分，国库亏空啦！你们什么时候来救我啊！`,
        undefined,
        '04-委屈',
      )
    }
  }
  return { ok: true, guoku: total, assets: treasury.assets, totalSiphoned: treasury.totalSiphoned, cut, report: rep }
}

// ---------------- 基础控制 ----------------
export async function say(text, animName, face) {
  const patch = { say: { id: Date.now(), text: String(text || '') } }
  if (face) patch.say.face = face
  if (animName) patch.anim = { id: Date.now(), name: animName, loop: false }
  return writeState(patch)
}
export async function play(animName, loop = true) {
  return writeState({ anim: { id: Date.now(), name: String(animName || IDLE), loop: loop !== false } })
}
export async function show() { return writeState({ visible: true }) }
export async function hide() { return writeState({ visible: false }) }

/** 工作状态：hook 桥与 MCP 共用 */
export async function setWork({ active, state, task, done, total, approval, sessionId }) {
  const a = active === true
  return writeState({
    work: {
      active: a,
      state: state || (a ? (approval ? 'approval' : 'working') : 'idle'),
      task: String(task ?? ''),
      done: Number(done ?? 0) || 0,
      total: Number(total ?? 0) || 0,
      approval: String(approval ?? ''),
      sessionId: sessionId ?? (a ? 'workbuddy' : null),
      updatedAt: Date.now(),
    },
  })
}

// ---------------- 对话：皇上 ↔ 和大人（人格 + 三层记忆） ----------------
const memoryStore = createMemoryStore({ root: stateDir(), log })
let personaCache
async function loadPersona() {
  if (personaCache !== undefined) return personaCache
  try {
    personaCache = (await readFile(PERSONA_FILE, 'utf8')).trim()
  } catch {
    personaCache = '你是和珅，称用户为皇上，自称奴才。口语、京腔、爱打算盘；先揣摩对方要什么，话不说死，给对方留台阶。'
  }
  return personaCache
}
const MEMORY_HINT = '以上是你的记忆（画像、目录、命中的分记忆）。用得上就自然带一句「奴才记得……」，用不上别硬提；记忆里没有的事，别编。'

/** 皇上问一句 → 和大人回一句，然后记进三层记忆 */
export async function answerChat(current, pending) {
  const text = String(pending?.text ?? '').trim()
  const agentReply = String(pending?.agentReply ?? '').trim()
  if (!text) return { ok: false, error: 'empty text' }

  // ---- 颤栗值 / 官位：先把这句话的影响算进去（复刻 DSH 新版 mood 链）----
  const moodBefore = await loadMood()
  const trembleBefore = moodBefore.tremble
  const cls = classify(text)
  const applied = applyTurn(moodBefore, cls)
  const moodAfter = applied.state
  await saveMood(moodAfter)
  if (applied.entered) log(`[core] 进入「${applied.entered}」状态（颤栗值 ${applied.before} → ${applied.after}）`)
  if (applied.released) log(`[core] 解除「${applied.released}」状态（颤栗值回到 ${applied.after}）`)
  if (cls.rank) log(`[core] 官位指令 ${cls.rank.dir}/${cls.rank.n} → ${rankLabel(moodAfter.rank)}`)

  const persona = await loadPersona()
  const personaTokens = estimateTokens(persona)
  let injected = { text: '', picked: [], used: { profile: 0, main: 0, catalog: 0, shard: 0 } }
  try {
    injected = await memoryStore.retrieve(text)
  } catch (error) {
    log(`[core] 记忆检索失败：${error.message}`)
  }
  const moodDir = directiveFor(moodAfter, cls, trembleBefore)
  const system = [persona, injected.text, MEMORY_HINT, moodDir].filter(Boolean).join('\n\n')
  const { messages: historyMessages, tokens: historyTokens } = memoryStore.historyForPrompt()

  // 回复来源：胆战心惊→固定认错话术；否则优先用 WorkBuddy Agent 直接生成的回复（agentReply）。
  // 绝不调用任何外部大模型 API。没有 Agent 回复时（例如桌面聊天窗离线输入）才用本地话术兜底。
  let reply = ''
  if (moodAfter.state === 'dread') {
    reply = pick(DREAD_LINES)
  } else if (agentReply) {
    reply = agentReply
  }
  const offline = !reply && moodAfter.state !== 'dread'
  if (!reply) reply = pick(LINES.offline)
  // 端点硬话术前缀（升无可升/降无可降）
  const forced = forcedReply(moodAfter)
  if (forced.length) reply = `${forced.join('')}${reply}`

  // 先记再回
  let remembered = null
  try {
    remembered = await memoryStore.remember({ question: text, reply })
    await memoryStore.pushHistory('user', text)
    await memoryStore.pushHistory('assistant', reply)
    await memoryStore.recordTurn({
      personaTokens, injected, replyTokens: estimateTokens(reply),
      cat: remembered?.cat, where: remembered?.where,
    })
  } catch (error) {
    log(`[core] 记忆写入失败：${error.message}`)
  }

  const messages = [
    ...(Array.isArray(current.chat?.messages) ? current.chat.messages : []),
    { id: Date.now(), role: 'assistant', text: reply, at: Date.now(), offline },
  ]
  // 把 mood 视图同步进 state，窗口据此播「被参一本」/「背手」动画
  const moodViewNow = publicView(moodAfter)
  await writeState({
    chat: { ...(current.chat || {}), open: true, messages, pending: null },
    mood: moodViewNow,
  })
  // 胆战心惊状态下不弹气泡（只保持「被参一本」形象）
  if (moodAfter.state !== 'dread') {
    await say(reply.length > 60 ? reply.slice(0, 58) + '…' : reply)
  }

  return {
    ok: true, reply, offline, remembered,
    picked: injected.picked,
    tokens: injected.used.profile + injected.used.main + injected.used.catalog + injected.used.shard,
    mood: moodViewNow,
  }
}

/**
 * 为 WorkBuddy Agent 组装「生成回复所需的全部上下文」。
 * Agent（当前会话模型）读到这份材料后，以和珅人格自行写出回复，
 * 再调用 submitReply / chat(agentReply) 把回复写回桌宠。全程不触碰任何外部大模型 API。
 */
export async function chatContext(text) {
  const t = String(text || '').trim()
  if (!t) return { ok: false, error: 'chat_context 需要 text' }

  const mood = await loadMood()
  const cls = classify(t)
  const projected = applyTurn(mood, cls) // 仅预览这句话对颤栗值/官位的影响，不落盘
  const moodDir = directiveFor(projected.state, cls, mood.tremble)
  const persona = await loadPersona()
  let injected = { text: '', picked: [], used: { profile: 0, main: 0, catalog: 0, shard: 0 } }
  try { injected = await memoryStore.retrieve(t) } catch {}
  const { messages: history } = memoryStore.historyForPrompt()
  const forced = forcedReply(projected.state)

  // 给 Agent 的指令：把 persona/记忆/口吻指令打包成一段可直接遵循的 system 提示
  const instructions = [
    '你现在扮演和珅（和大人），用户是皇上，你自称奴才。',
    persona,
    injected.text && `【和大人记得】\n${injected.text}`,
    MEMORY_HINT,
    moodDir && `【此刻的心气/口吻要求】\n${moodDir}`,
    forced.length && `【必须原样带上的话】${forced.join('')}`,
    projected.state === 'dread' && '注意：此刻你胆战心惊，只需求饶认错，别正常答题。',
  ].filter(Boolean).join('\n\n')

  return {
    ok: true,
    text: t,
    instructions,
    persona,
    memory: injected.text,
    memoryHits: injected.picked,
    moodDirective: moodDir,
    forcedPrefix: forced.join(''),
    mood: publicView(projected.state),
    dread: projected.state === 'dread',
    history,
    note: '请严格以和珅口吻，针对 text 给出一句简短回复（不宜超过 60 字）；只输出回复正文，不要解释、不要引号。',
  }
}

/** 皇上说话：写入用户消息 + pending。agentReply 由 WorkBuddy Agent 提供（走当前会话模型）。
 *  @param {string} text 皇上说的话
 * @param {string} agentReply WorkBuddy Agent 生成的和大人回复；不传则本地话术兜底
 */
export async function chat(text, agentReply = '') {
  const t = String(text || '').trim()
  if (!t) return { ok: false, error: 'chat 需要 text' }
  const current = await readState()
  const now = Date.now()
  const messages = [
    ...(Array.isArray(current.chat?.messages) ? current.chat.messages : []),
    { id: now, role: 'user', text: t, at: now },
  ]
  await writeState({
    chat: { ...(current.chat || {}), open: true, messages, pending: { id: now + 1, text: t, agentReply } },
  })
  const result = await answerChat(await readState(), { id: now + 1, text: t, agentReply })
  const after = await readState()
  return { ok: result.ok, reply: result.reply, offline: result.offline, chat: after.chat, mood: result.mood || after.mood }
}

/** 提交 WorkBuddy Agent 生成的回复（等价于 chat(text, agentReply)，语义更直白，供 MCP/CLI 用） */
export async function submitReply(text, agentReply) {
  return chat(text, agentReply)
}

/** 兼容旧引用：模型固定为 WorkBuddy 当前会话，切换是空操作 */
export async function setChatModel(_ignored) {
  return { ok: true, model: 'workbuddy', label: 'WorkBuddy 当前会话模型', available: true }
}

export async function showLedger(current) {
  let text
  try {
    text = memoryStore.ledger()
  } catch (error) {
    text = `（拱手）账本一时翻不开：${error.message}`
  }
  const messages = [
    ...(Array.isArray(current?.chat?.messages) ? current.chat.messages : []),
    { id: Date.now(), role: 'assistant', text, at: Date.now() },
  ]
  await writeState({ chat: { ...(current.chat || {}), open: true, messages, pending: null } })
  return text
}

export async function memorySnapshot() {
  return memoryStore.snapshot()
}
export async function memorySearch(query) {
  const q = String(query || '').trim()
  if (!q) return { ok: false, error: 'memory_search 需要 query' }
  const hit = await memoryStore.retrieve(q)
  return {
    ok: true, query: q, picked: hit.picked,
    tokens: hit.used.profile + hit.used.main + hit.used.catalog + hit.used.shard,
    used: hit.used, text: hit.text,
  }
}

/** 状态摘要（供 MCP render / status） */
export async function statusSummary() {
  const s = await readState()
  return {
    ok: true,
    visible: s.visible,
    anim: s.anim,
    say: s.say,
    work: s.work,
    treasury: s.treasury || null,
    chatModel: 'workbuddy', // 固定使用 WorkBuddy 当前会话模型
    mood: s.mood || null,
    fishPlayEnabled: await readFishPlay(),
  }
}

// ---------------- 捕鱼：已按用户要求注释/关闭 ----------------
// 原 DSH 版通过 createDshPetBridge 定位并捕捉 dsh-pet 的「大肥鱼」。
// 由于依赖 DSH 宿主且用户要求先注释，这里保留占位但不执行。
/*
export async function fishStatus()   { return { ok: false, reason: '捕鱼功能已注释（FISH_ENABLED=false）' } }
export async function fishHide()     { return { ok: false, reason: '捕鱼功能已注释（FISH_ENABLED=false）' } }
export async function fishShow()     { return { ok: false, reason: '捕鱼功能已注释（FISH_ENABLED=false）' } }
*/

/** 初始化：确保状态目录存在、国库字段就位 */
export async function init() {
  await mkdir(stateDir(), { recursive: true })
  await loadTreasury()
  const s = await readState()
  if (!s.treasury) {
    await writeState({ treasury: { guoku: treasury.lastBalance, assets: treasury.assets, updatedAt: Date.now() } })
  }
  log('[core] WorkBuddy 和大人核心引擎已就绪')
  return true
}
