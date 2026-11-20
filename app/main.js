const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Tray,
  Menu,
  nativeImage,
} = require('electron')
const fs = require('node:fs')
const { execFile, spawn } = require('node:child_process')
const readline = require('node:readline')
const path = require('node:path')
const os = require('node:os')

const capture = require('./capture')
const winprobe = require('./winprobe')

/**
 * WorkBuddy 通用版改造（相对 DSH 原版）：
 * 1) 应用名带 WorkBuddy 后缀，userData 指向独立目录 —— 与 DSH 老版彻底隔离，
 *    两版不会抢单实例锁（互斥体从 userData 派生），进程/托盘一眼可辨。
 * 2) 状态目录从 ~/.dsh/hedaren-pet 改为 ~/.workbuddy/hedaren-pet（HEDAREN_PET_HOME 可覆盖）。
 * 3) 捕鱼改为开关控制（一次性）：开启后飞行满 2 秒定身 → 捕鱼判定（80% 成功）→ 播撒网动画 →
 *    捕鱼计数 +1（desktop-treasury.json 的 fish/fishHistory）→ 恢复飞行，用掉后开关自动关；
 */
const EDITION_SUFFIX = ' [WorkBuddy]'
const EDITION_LABEL = `和大人${EDITION_SUFFIX}`

// 捕鱼玩法开关：默认关。存在状态文件的 fishPlayEnabled 里，右键可切换（一次性玩法）。
// 开启后：飞行满 FISH_PLAY_AFTER_MS 定身停下 → 捕鱼判定 → 播「网住大肥鱼」→ 计数 +1 → 恢复飞行，
// 用掉一次后开关自动关闭，下次需手动再开。
const FISH_PLAY_AFTER_MS = 2000
const FISH_ANIM_MS = 4200 // 「网住大肥鱼」动画时长约 4000ms，稍留余量再恢复飞行
const FISH_CATCH_RATE = 0.8 // 捕鱼判定成功率（随机）
const FISH_PLAY_FILE = () => path.join(STATE_DIR, 'fish-play.json')
const TREASURY_FILE = () => path.join(STATE_DIR, 'desktop-treasury.json')

/** 捕鱼计数 +1：写 desktop-treasury.json 的 fish / fishHistory，返回累计条数（失败返回 null） */
function recordFishCatch() {
  try {
    let t = {}
    try { t = JSON.parse(fs.readFileSync(TREASURY_FILE(), 'utf8')) } catch {}
    t.fish = Math.max(0, Math.round(Number(t.fish) || 0)) + 1
    t.fishHistory = [{ at: Date.now() }, ...(Array.isArray(t.fishHistory) ? t.fishHistory : [])].slice(0, 50)
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(TREASURY_FILE(), JSON.stringify(t, null, 2), 'utf8')
    return t.fish
  } catch (e) {
    log(`fish count save failed: ${e?.message || e}`)
    return null
  }
}
function readFishPlayEnabled() {
  try {
    const raw = JSON.parse(fs.readFileSync(FISH_PLAY_FILE(), 'utf8'))
    return raw?.enabled === true
  } catch {
    return false // 一次性玩法：默认关闭，需右键手动开启
  }
}
function writeFishPlayEnabled(enabled) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(FISH_PLAY_FILE(), JSON.stringify({ enabled: Boolean(enabled) }, null, 2), 'utf8')
  } catch (e) {
    log(`fish play save failed: ${e?.message || e}`)
  }
}

const PET_HOME = process.env.HEDAREN_PET_HOME || path.join(os.homedir(), '.workbuddy', 'hedaren-pet')
const STATE_DIR = PET_HOME
const STATE_FILE = path.join(STATE_DIR, 'desktop-state.json')
const LOG_FILE = path.join(STATE_DIR, 'desktop-app.log')

const USER_DATA_DIR = path.join(STATE_DIR, 'electron-userdata')
try { fs.mkdirSync(USER_DATA_DIR, { recursive: true }) } catch {}
try {
  app.setName(`和大人${EDITION_SUFFIX}`)
  app.setPath('userData', USER_DATA_DIR)
} catch {}
void EDITION_LABEL

/**
 * 透明置顶窗被别的窗口整块盖住时，Chromium 会把这类窗口记为「被遮挡」并暂停合成，
 * webp 动画/CSS 呼吸就停在最后一帧——表现就是「和大人不动了，点一下或开个菜单又活了」。
 * 这几条开关把后台化/遮挡降频关掉，让它一直按正常帧率跑。
 */
for (const flag of [
  'disable-backgrounding-occluded-windows',
  'disable-renderer-backgrounding',
  'disable-background-timer-throttling',
]) {
  try {
    app.commandLine.appendSwitch(flag)
  } catch {}
}

const BUBBLE_W = 300
const BUBBLE_H = 132
const JAIL_THRESHOLD_FILE = () => path.join(STATE_DIR, 'jail-threshold.json')

/** 亏空阈值（积分）的默认值：没设置过时按 10 积分算 */
const DEFAULT_JAIL_THRESHOLD = 10

/** 读亏空阈值（积分）。没有就返回默认值 10 */
function readJailThreshold() {
  try {
    const raw = JSON.parse(fs.readFileSync(JAIL_THRESHOLD_FILE(), 'utf8'))
    const v = Number(raw?.value)
    return Number.isFinite(v) && v >= 0.01 && v <= 10000 ? Math.round(v * 100) / 100 : DEFAULT_JAIL_THRESHOLD
  } catch {
    return DEFAULT_JAIL_THRESHOLD
  }
}

function writeJailThreshold(value) {
  try {
    const file = JAIL_THRESHOLD_FILE()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ value: Math.round(value * 100) / 100, updatedAt: Date.now() }, null, 2), 'utf8')
    return true
  } catch (error) {
    log(`jail threshold write failed ${error?.message}`)
    return false
  }
}

// 菜单是「主列 + 悬停展开的二级列」，两块并排放在画布里；只有这两块矩形吃点击
const MENU_COL_W = 220
const MENU_SUB_W = 206
const MENU_GAP = 6
const MENU_BOX_W = MENU_COL_W + MENU_GAP + MENU_SUB_W
const MENU_MAX_H = 560 // 菜单首次弹出时按这个高度开画布，量到真实高度后再收紧
const CHAT_W = 330
const CHAT_H = 360

const DEFAULT_STATE = {
  version: 1,
  visible: true,
  say: null,
  anim: { id: 0, name: '待机-呼吸', loop: true },
  x: null,
  y: null,
  throwSettleMs: 50,
}

const THROW_SETTLE_MIN = 50
const THROW_SETTLE_MAX = 500

function clampSettle(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return THROW_SETTLE_MIN
  return Math.max(THROW_SETTLE_MIN, Math.min(THROW_SETTLE_MAX, n))
}

const GRAVITY = 1400
const RESTITUTION = 0.78
const FLOOR_FRICTION = 2.5
const MAX_SPEED = 3600

let win = null
/**
 * 架构：**一个窗口 = 一块画布**（跟 dsh-pet 一样）。
 * 角色本体、气泡、右键菜单都画在 win 这个渲染进程里的三个图层上，
 * 窗口按需扩缩把三层都框进去，透明区域用 setIgnoreMouseEvents(forward) 打穿。
 * 所以常驻进程数是 main + GPU + network + renderer = 4。
 */
let petRect = { x: 0, y: 0, w: 200, h: 259 } // 角色本体占的屏幕矩形（DIP，含 PAD）
let canvasRect = { x: 0, y: 0, w: 200, h: 259 } // 当前窗口矩形（DIP）
let bubbleBox = null // 气泡图层的屏幕矩形（DIP）；null = 不显示
let menuBox = null // 菜单图层的屏幕矩形（DIP）；null = 菜单收起
let menuRegions = [] // 菜单里真正吃点击的矩形（主列 / 二级列），空 = 退回整块 menuBox
let layoutSig = '' // 上一次发给渲染端的布局签名，避免每帧重发
let interactive = null // 当前是否可点（null = 还没同步过）
let chatWin = null
let tray = null
let saveTimer = null
let throwTimer = null
let visibilityTimer = null
let sayTimer = null
let keepTopTimer = null
let menuWatchdog = null
let bubbleContentH = BUBBLE_H
let menuContentH = MENU_MAX_H
let fishTarget = null // state.dshpet：大肥鱼此刻的屏幕框（DIP）
let captureLock = false // 一次碰撞只判定一次，等动画播完再解锁
let fishPresent = true // 槽位里此刻有没有大肥鱼（像素检测）
let fishHelper = null // dsh-pet 的桌面宠物窗口（宠物其实画在这个窗口里）
let fishHelpers = [] // 每只桌宠一个同标题窗口，全都记下来
let fishDetectRect = null // 扫像素扫出来的大肥鱼实框（屏幕 DIP）
let fishDetectAt = 0
let fishDetecting = false
let lastMoveAt = 0 // 最后一次拖动位移的时间：拖动期间不做像素扫描（同步扫描会卡住拖拽）
let fishEverSeen = false // 这一次运行里见过大肥鱼没有：从没见过 = 可能客户端根本没渲染
const FISH_FRESH_MS = 8000 // 像素扫描的新鲜期：比轮询间隔（5 秒）宽一点
let fishWindowCount = 0 // 上一次扫描看到的窗口数：0 = 探测本身失败，不能据此断言她不在
let fishSlots = [] // 这一轮扫到的所有碰撞框（桌面窗口里的她 + 网页/DSH 窗口里的她）
let fishGateOpen = false // 捕鱼门禁：插件装着+启用+她显示着，才做探测
let fishGateReason = 'unknown' // 门禁原因（no-plugin / fish-hidden / ok…）
let flightFacing = '' // 最近一次飞行朝向：'left' | 'right' | ''
let menuOpenAt = 0
let menuOutsideTicks = 0
let lastVisibility = null
let lastSayId = -1
let lastFishPreviewAt = 0 // MCP fish_preview 信号去重
let lastMansionOpenAt = 0 // MCP mansion 信号去重
let currentMetrics = { width: 200, height: 259, left: 80, top: 101, scale: 1 }

function log(...args) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${args.join(' ')}\n`)
  } catch {}
}

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_STATE, ...parsed, anim: { ...DEFAULT_STATE.anim, ...(parsed.anim || {}) } }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

function writeState(next) {
  const current = readState()
  const merged = {
    ...current,
    ...next,
    anim: next && next.anim ? { ...current.anim, ...next.anim } : current.anim,
    say: next && Object.prototype.hasOwnProperty.call(next, 'say') ? next.say : current.say,
    updatedAt: Date.now(),
  }
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(merged, null, 2), 'utf8')
  return merged
}

function petBounds() {
  return { x: petRect.x, y: petRect.y, width: petRect.w, height: petRect.h }
}

/**
 * 画布余量：跟 dsh-pet 一样「窗口 = 本体 + 四周透明余量」，气泡和菜单都画在余量里。
 * 固定余量 = 平时一次 resize 都不做（气泡反复出现/消失不会抖）；菜单超高时才临时长高。
 */
const CANVAS_MARGIN = { l: 120, r: 120, t: 150, b: 96 }

/** 两个屏幕矩形求并：画布 = 本体+余量 ∪ 气泡 ∪ 菜单 */
function unionRect(a, b) {
  if (!b) return a
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.w, b.x + b.w)
  const bottom = Math.max(a.y + a.h, b.y + b.h)
  return { x, y, w: right - x, h: bottom - y }
}

/** 本体 + 固定余量 = 基础画布 */
function baseCanvasRect() {
  return {
    x: petRect.x - CANVAS_MARGIN.l,
    y: petRect.y - CANVAS_MARGIN.t,
    w: petRect.w + CANVAS_MARGIN.l + CANVAS_MARGIN.r,
    h: petRect.h + CANVAS_MARGIN.t + CANVAS_MARGIN.b,
  }
}

/** 气泡图层放哪：贴在基础画布上方留白里（不参与 resize，所以画布尺寸恒定） */
function bubbleRectFor(height) {
  const h = Math.max(48, Math.min(BUBBLE_H, Math.round(height || BUBBLE_H)))
  const w = BUBBLE_W
  const base = baseCanvasRect()
  const x = Math.round(petRect.x + petRect.w / 2 - w / 2)
  // 底部贴着本体上沿，但整体必须留在画布内（画布会因菜单临时变化，所以在这重新取一次）
  const r = unionRect(base, menuBox)
  const bottomAligned = Math.round(petRect.y - h + 2)
  const y = Math.max(r.y + 4, bottomAligned)
  return {
    x: Math.min(Math.max(r.x + 4, x), r.x + r.w - w - 4),
    y: Math.min(y, r.y + r.h - h - 4),
    w,
    h,
  }
}

/** 画布变了就改窗口尺寸，并把三层在窗口内的偏移告诉渲染端 */
function applyCanvas() {
  if (!win || win.isDestroyed()) return
  let r = baseCanvasRect()
  r = unionRect(r, menuBox)
  canvasRect = r
  const cur = win.getBounds()
  const x = Math.round(r.x)
  const y = Math.round(r.y)
  const width = Math.round(r.w)
  const height = Math.round(r.h)
  if (cur.x !== x || cur.y !== y || cur.width !== width || cur.height !== height) {
    win.setBounds({ x, y, width, height })
  }
  const layout = {
    ox: Math.round(petRect.x - r.x),
    oy: Math.round(petRect.y - r.y),
    petW: Math.round(petRect.w),
    petH: Math.round(petRect.h),
    bubble: bubbleBox
      ? { x: Math.round(bubbleBox.x - r.x), y: Math.round(bubbleBox.y - r.y), w: bubbleBox.w, h: bubbleBox.h }
      : null,
    menu: menuBox
      ? { x: Math.round(menuBox.x - r.x), y: Math.round(menuBox.y - r.y), w: menuBox.w, h: menuBox.h, side: menuBox.side || 'right' }
      : null,
  }
  const sig = JSON.stringify(layout)
  if (sig === layoutSig) return
  layoutSig = sig
  try {
    win.webContents.send('win:layout', layout)
  } catch {}
}

/** 让气泡、菜单的位置跟着和大人走（旧接口，位置现在由画布统一算） */
function syncSatellites() {
  if (!win || win.isDestroyed() || !bubbleBox) return
  const next = bubbleRectFor(bubbleBox.h || bubbleContentH)
  if (bubbleBox.x === next.x && bubbleBox.y === next.y && bubbleBox.h === next.h) return
  bubbleBox = next
  applyCanvas()
}

function showBubbleWindow() {
  if (!win || win.isDestroyed()) return
  const next = bubbleRectFor(bubbleContentH)
  if (bubbleBox && bubbleBox.x === next.x && bubbleBox.y === next.y && bubbleBox.h === next.h) return
  bubbleBox = next
  applyCanvas()
}

function hideBubbleWindow() {
  if (!bubbleBox) return
  bubbleBox = null
  applyCanvas()
}

function bubbleVisible() {
  return Boolean(bubbleBox)
}

function openChat() {
  ensureChatWindow()
  if (!chatWin || chatWin.isDestroyed()) return
  const pet = petBounds()
  if (pet) {
    const area = screen.getDisplayMatching(pet).workArea
    const x = Math.round(pet.x + pet.width / 2 - CHAT_W / 2)
    const y = Math.round(pet.y - CHAT_H - 12)
    chatWin.setBounds({
      x: Math.min(Math.max(area.x + 6, x), area.x + area.width - CHAT_W - 6),
      y: Math.min(Math.max(area.y + 6, y), area.y + area.height - CHAT_H - 6),
      width: CHAT_W,
      height: CHAT_H,
    })
  }
  chatWin.show()
  chatWin.focus()
}

/**
 * 聊天窗是惰性窗口：用到才建，关掉就销毁。
 * 这样一个渲染进程都不白占（闲置时进程数 = main + GPU + network + 角色 = 4）。
 */
function closeChat() {
  if (!chatWin || chatWin.isDestroyed()) return
  const target = chatWin
  chatWin = null
  try {
    target.hide()
  } catch {}
  // 先 hide 再 destroy，避免关窗动画里直接炸掉渲染进程
  setTimeout(() => {
    try {
      if (!target.isDestroyed()) target.destroy()
    } catch {}
  }, 60)
}

/**
 * 直接给画布里的某个 iframe 发消息。
 * `webContents.send` 只到主框架，postMessage 又要靠主框架转发（链路长、容易丢），
 * 这里用 webFrameMain.send 精确投递。
 */
function sendToFrame(match, channel, ...args) {
  try {
    for (const frame of win.webContents.mainFrame.frames) {
      if (frame.url && frame.url.includes(match)) frame.send(channel, ...args)
    }
  } catch {}
}

function openMenu(x, y) {
  if (!win || win.isDestroyed()) return
  const area = screen.getDisplayNearestPoint({ x, y }).workArea
  const height = Math.min(menuContentH || MENU_MAX_H, area.height - 20)
  // 主列要贴在光标那一侧；二级列往旁边弹，右边没地方就翻到左边
  const roomRight = area.x + area.width - 6 - Math.round(x)
  const side = roomRight >= MENU_COL_W + 6 + MENU_SUB_W ? 'right' : 'left'
  const anchor = Math.round(x)
  const px = Math.min(
    Math.max(area.x + 6, side === 'right' ? anchor : anchor - MENU_BOX_W + MENU_COL_W),
    area.x + area.width - MENU_BOX_W - 6,
  )
  const py = Math.min(Math.max(area.y + 6, Math.round(y)), area.y + area.height - height - 6)
  menuBox = { x: px, y: py, w: MENU_BOX_W, h: height, side }
  menuRegions = []
  applyCanvas()
  win.moveTop()
  menuOpenAt = Date.now()
  startMenuWatchdog()
  // 菜单是画布里的 iframe：精确投给那个子框架（先给边，再让它重铺一遍）
  sendToFrame('menu.html', 'menu:side', menuBox.side)
  sendToFrame('menu.html', 'menu:opened')
}

/** 菜单里真正吃点击的矩形（主列 + 展开的二级列），由菜单自己量好上报 */
ipcMain.on('menu:regions', (_event, rects) => {
  if (!menuBox || !Array.isArray(rects)) return
  menuRegions = rects
    .filter((r) => r && Number(r.w) > 0 && Number(r.h) > 0)
    .map((r) => ({
      x: menuBox.x + Number(r.x || 0),
      y: menuBox.y + Number(r.y || 0),
      w: Number(r.w),
      h: Number(r.h),
    }))
})

/** 菜单是同一块画布上的图层，主窗口不可聚焦时不会触发 blur；用光标位置判断「点外面」。 */
function startMenuWatchdog() {
  stopMenuWatchdog()
  menuOutsideTicks = 0
  // 自检模式：菜单不自动收（截图/量尺寸时要用）
  if (fs.existsSync(path.join(STATE_DIR, 'test-menu.flag'))) return
  menuWatchdog = setInterval(() => {
    if (!menuBox) {
      stopMenuWatchdog()
      return
    }
    const b = menuBox
    const p = screen.getCursorScreenPoint()
    const inside =
      p.x >= b.x - 6 && p.x <= b.x + b.w + 6 && p.y >= b.y - 6 && p.y <= b.y + b.h + 6
    if (inside) {
      menuOutsideTicks = 0
      return
    }
    menuOutsideTicks += 1
    // 连续两次都在外面（≈240ms）才关，避免刚弹出时光标抖动误判
    if (menuOutsideTicks >= 2 && Date.now() - menuOpenAt > 150) {
      if (process.env.HEDAREN_KEEP_MENU === '1') return
      hideMenu()
    }
  }, 120)
  menuWatchdog.unref?.()
}

function stopMenuWatchdog() {
  if (menuWatchdog) {
    clearInterval(menuWatchdog)
    menuWatchdog = null
  }
}

function hideMenu() {
  stopMenuWatchdog()
  if (!menuBox) return
  menuBox = null
  menuRegions = []
  applyCanvas()
  // 菜单收起后把工作中的气泡补回来
  if (readState().work?.active) showBubbleWindow()
}

function menuVisible() {
  return Boolean(menuBox)
}

function showPet() {
  writeState({ visible: true })
  if (win) {
    win.showInactive()
    win.moveTop()
  }
  if (readState().work?.active) showBubbleWindow()
}

function hidePet() {
  stopThrow()
  hideBubbleWindow()
  hideMenu()
  closeChat()
  writeState({ visible: false })
  if (win) win.hide()
}

function togglePet() {
  if (readState().visible === false) showPet()
  else hidePet()
  refreshTray()
}

function stopThrow(notify = true) {
  try {
    win?.webContents.send('win:facing', '')
    // 飞行结束（落地/撞鱼/用户又按下）：让渲染端把「甩飞」形象收掉，别卡在那儿。
    // 注意：throwWindow() 开头也会调 stopThrow()，那次是在「起飞前」清场，不能发这个信号，
    // 否则刚亮起来的甩飞形象会被立刻收掉（现象：甩飞时看不到举网形象）。
    if (notify) {
      win?.webContents.send('win:throwState', { active: false, dir: '' })
      win?.webContents.send('win:throwEnd')
    }
  } catch {}
  if (throwTimer) {
    clearInterval(throwTimer)
    throwTimer = null
  }
}

function setupTray() {
  try {
    const image = nativeImage.createFromPath(path.join(__dirname, 'tray.png'))
    tray = new Tray(image)
    tray.setToolTip(EDITION_LABEL)
    refreshTray()
    tray.on('double-click', togglePet)
  } catch (error) {
    log(`tray failed ${error?.message || error}`)
  }
}

/** 托盘菜单：显示/隐藏、守护进程开关、和大人府邸、退出（都带 WorkBuddy 后缀，与 DSH 版区分）。 */
function refreshTray() {
  if (!tray) return
  const hidden = readState().visible === false
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: hidden ? `显示和大人${EDITION_SUFFIX}` : `隐藏和大人${EDITION_SUFFIX}`, click: togglePet },
      { label: daemonRunning() ? '守护进程：运行中（点击关闭）' : '守护进程：已关闭（点击开启）', click: toggleDaemon },
      { label: `和大人府邸${EDITION_SUFFIX}`, click: openMansion },
      { type: 'separator' },
      { label: `退出桌宠${EDITION_SUFFIX}`, click: () => app.quit() },
    ]),
  )
  tray.setToolTip(hidden ? `${EDITION_LABEL}（已隐藏）` : EDITION_LABEL)
}

// ---- 守护进程手动启停（托盘右键切换；不再随桌宠自动拉起）----
const DAEMON_LOCK_FILE = () => path.join(STATE_DIR, 'daemon.lock')
const DAEMON_SCRIPT = path.join(__dirname, '..', 'pet-daemon.js')

function daemonPidAlive(pid) {
  if (!pid || pid === process.pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function readDaemonLock() {
  try {
    const lock = JSON.parse(fs.readFileSync(DAEMON_LOCK_FILE(), 'utf8'))
    return lock && lock.pid ? lock : null
  } catch { return null }
}

/** 守护进程是否活着：pid 存活 + 心跳 60 秒内（守护进程每 5 秒 touch 一次锁文件） */
function daemonRunning() {
  const lock = readDaemonLock()
  return Boolean(lock && daemonPidAlive(lock.pid) && Date.now() - (lock.ts || 0) < 60_000)
}

function toggleDaemon() {
  if (daemonRunning()) {
    const lock = readDaemonLock()
    try { process.kill(lock.pid); log(`daemon stop: killed pid=${lock.pid}`) } catch (e) { log(`daemon stop failed: ${e?.message}`) }
  } else {
    try {
      const childEnv = { ...process.env, HEDAREN_PET_HOME: STATE_DIR }
      delete childEnv.ELECTRON_RUN_AS_NODE // 防止误把 node 当 Electron 用
      const child = spawn(findNodeExe(), [DAEMON_SCRIPT], { detached: true, stdio: 'ignore', env: childEnv })
      child.unref()
      log(`daemon start: spawned pid=${child.pid}`)
    } catch (e) {
      log(`daemon start failed: ${e?.message}`)
    }
  }
  // 锁文件/进程状态要一点时间稳定，稍后刷新托盘标签
  setTimeout(refreshTray, 1500)
}

/** 每 5 秒核对一次守护进程状态，标签变了才重画托盘菜单 */
function startDaemonTrayWatcher() {
  let last = null
  const timer = setInterval(() => {
    const running = daemonRunning()
    if (running !== last) { last = running; refreshTray() }
  }, 5000)
  timer.unref?.()
}

/** 状态轮询：气泡该不该出现、主窗口该不该显示。 */
function startStateWatcher() {
  if (visibilityTimer) clearInterval(visibilityTimer)
  visibilityTimer = setInterval(() => {
    if (!win) return
    // 拖动期间不读盘：readState() 是同步 readFileSync + JSON.parse，
    // 400ms 一次在 Windows 上容易被磁盘/杀软拖住，正好打断拖拽帧
    if (Date.now() - lastMoveAt < 300) return
    let state
    try {
      state = readState()
    } catch {
      return
    }
    // WorkBuddy 版：捕鱼不再依赖 DSH 的大肥鱼插件门禁，改由本地开关驱动。
    // 真实检测/捕捉链（detectFish/runCapture/hideFishNow）全部停用，只保留「飞行 2 秒播动画」。
    const fishPlayOn = readFishPlayEnabled()
    if (fishGateOpen !== fishPlayOn) {
      fishGateOpen = fishPlayOn
      log(`fish play (visual only) -> ${fishPlayOn ? 'open' : 'closed'}`)
    }
    fishGateReason = fishPlayOn ? '本地开关开启：飞行 2 秒播撒网动画（纯视觉）' : '本地开关关闭'
    fishTarget = null
    fishHelpers = []
    fishHelper = null

    // MCP 信号消费：预览撒网动画 / 打开府邸窗口
    const previewAt = Number(state.fishPreviewAt) || 0
    if (previewAt && previewAt !== lastFishPreviewAt) {
      lastFishPreviewAt = previewAt
      try { win?.webContents.send('win:netVisual', { facing: flightFacing || 'right' }) } catch {}
    }
    const mansionAt = Number(state.mansionOpenAt) || 0
    if (mansionAt && mansionAt !== lastMansionOpenAt) {
      lastMansionOpenAt = mansionAt
      log('open mansion via MCP signal')
      openMansion()
    }

    if (state.visible !== lastVisibility) {
      lastVisibility = state.visible
      log(`visibility ${state.visible === false ? 'hidden' : 'shown'}`)
      refreshTray()
    }
    if (state.visible === false) {
      if (win.isVisible()) win.hide()
      hideBubbleWindow()
      return
    }
    if (!win.isVisible()) win.showInactive()

    const workActive = Boolean(state.work && state.work.active)
    const sayId = Number(state.say?.id) || 0
    if (sayId && sayId !== lastSayId) {
      lastSayId = sayId
      showBubbleWindow()
      if (sayTimer) clearTimeout(sayTimer)
      sayTimer = setTimeout(() => {
        sayTimer = null
        if (!readState().work?.active) hideBubbleWindow()
      }, 9000)
    }
    // 大肥鱼会走、会被拖：每 5 秒扫一次像素，碰撞判定用最新的实框
    // 不再周期扫描：统一在「按下拖动」和「甩出去」这两个时刻扫描（省 CPU，也够准）
    if (workActive) {
      if (sayTimer) {
        clearTimeout(sayTimer)
        sayTimer = null
      }
      // 菜单打开时不抬气泡，避免盖住菜单
      if (!menuVisible()) showBubbleWindow()
    } else if (!sayTimer && sayId === lastSayId) {
      hideBubbleWindow()
    }
  }, 400)
}


/**
 * 找大肥鱼：截一张 1/4 屏，在 dsh-pet 的桌面宠物窗口里数「蓝毛」色像素。
 * 她的头发/裙子是饱和的蓝（b 明显大于 r），桌面别的窗口分得开。
 * 扫到就把像素团的包围盒换算成屏幕 DIP 记下来 —— 她会走、会被拖，配置推算的框靠不住。
 * 扫不到 = 她不在画面上（被关了/没显示），撞击必定失手。
 */
/** 配置推算的槽位（兜底）：手动校准 > dsh-pet 配置的角落/边距/尺寸 */
function configSlotRect() {
  const t = fishTarget
  if (!t || !t.rect) return null
  const r = t.rect
  if (![r.x, r.y, r.w, r.h].every((v) => Number.isFinite(Number(v)))) return null
  const box = { x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) }
  // desktop 表面（含 both）下，dsh-pet 的宠物是相对**屏幕工作区**按角落摆的，不是相对 DSH 窗口。
  // host（dshpet.js）拿不到屏幕几何，只能按窗口算，算出来的框会整体偏左上
  // （实测 1018,185 vs 真实 1242,133）。这里用「窗口右缘到框右缘」还原 marginX，
  // 再以工作区为锚重算，both 也一并按桌面那份算。
  if (t.surface === 'desktop' && t.window && Number.isFinite(Number(t.window.w))) {
    const wa = screen.getPrimaryDisplay().workArea
    const marginX = Number(t.window.x) + Number(t.window.w) - (box.x + box.w)
    const marginY = box.y - Number(t.window.y)
    return {
      x: Math.round(wa.x + wa.width - marginX - box.w),
      y: Math.round(wa.y + marginY),
      w: box.w,
      h: box.h,
    }
  }
  return box
}

/**
 * 碰撞用的框：刚扫出来的实框（10 秒内）> 手动校准 > 配置推算。
 * 大肥鱼会走、会被拖，扫出来的才是真的。
 */
function fishSlotRect() {
  // 门禁关（没插件/没启用/她没显示）→ 一个框都不给，撞空气也不会有判定
  if (!fishGateOpen) return null
  const fresh = fishDetectAt > 0 && Date.now() - fishDetectAt < FISH_FRESH_MS
  // 刚扫过、而且没扫到她：她确实不在画面上（被网走了/被关了/没显示）
  // 这时不能退回「配置推算的框」——那个框永远在，会让她明明不在也被撞出捕捉判定
  // 例外：一个桌宠窗口都没探测到（fishWindowCount=0）说明是探测失败，不是她不在，仍允许兜底
  if (fresh && fishWindowCount > 0 && !fishPresent) return null
  if (fresh && fishDetectRect) return { ...fishDetectRect, detected: true }
  // 还没扫过（启动瞬间）或扫描结果过期：才允许用手动校准 / 配置推算兜底
  if (!fresh) return configSlotRect()
  return null
}

/**
 * 整屏截图兜底：每个显示器一张，位置用 bounds（DIP），内容用 desktopCapturer。
 *
 * 为什么 macOS 需要它：dsh-pet 的桌面 helper 是 `app.dock.hide()` 的透明窗口，
 * - System Events 侧：探测脚本只枚举 `background only = false`，helper 被当成后台进程跳过；
 * - ScreenCaptureKit 侧：`getSources({types:['window']})` 的窗口列表里常常根本没有它。
 * 两条路都断，按标题找窗口就永远找不到鱼。整屏截图不依赖窗口枚举，
 * 蓝毛在哪都扫得到，扫出来的框本来也直接是屏幕 DIP。
 */
async function captureScreens() {
  try {
    const { desktopCapturer } = require('electron')
    const displays = screen.getAllDisplays()
    if (!displays.length) return []
    const maxW = Math.min(1920, Math.max(...displays.map((d) => d.size.width)))
    const maxH = Math.min(1080, Math.max(...displays.map((d) => d.size.height)))
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: maxW, height: maxH },
      fetchWindowIcons: false,
    })
    const out = []
    for (const src of sources) {
      const thumb = src.thumbnail
      if (!thumb || thumb.isEmpty()) continue
      const ts = thumb.getSize()
      if (!ts.width || !ts.height) continue
      const disp =
        displays.find((d) => String(d.id) === String(src.display_id)) || screen.getPrimaryDisplay()
      const b = disp.bounds
      out.push({
        kind: 'pet',
        title: src.name || 'screen',
        x: Math.round(b.x),
        y: Math.round(b.y),
        w: Math.round(b.width),
        h: Math.round(b.height),
        image: thumb,
        // 缩略图不保证 1:1，横竖分开换算；slot 计算会按这两个系数还原成 DIP
        scaleX: b.width / ts.width,
        scaleY: b.height / ts.height,
      })
    }
    return out
  } catch (error) {
    log(`screen capture failed ${error?.message || error}`)
    return []
  }
}

/**
 * 常驻抓图进程（只 Windows）。
 *
 * 为什么需要它：每次扫描都 spawn 一个 PowerShell，实测要 ~1.4 秒（进程启动 0.9s +
 * System.Drawing 0.35s + 编译）。甩飞是「松手就飞」，等不起 1.4 秒，于是起飞那一刻
 * 手上只有配置推算的旧框、或者干脆没有框（日志里的 `slots=none`），甩得快就从她
 * 身上穿过去了。常驻之后：进程只启动一次、DLL 只加载一次，之后一次抓图实测 35~40ms，
 * 甩飞前可以直接等这批坐标齐了再起飞。
 */
let captureDaemon = null
let captureDaemonSeq = 0
let captureDaemonIdle = 0
const CAPTURE_DAEMON_IDLE_MS = 5 * 60 * 1000

function stopCaptureDaemon(reason) {
  if (captureDaemonIdle) {
    clearTimeout(captureDaemonIdle)
    captureDaemonIdle = 0
  }
  const d = captureDaemon
  captureDaemon = null
  if (!d) return
  for (const pending of d.pending.values()) pending.resolve(null)
  d.pending.clear()
  try {
    if (!d.proc.killed) d.proc.stdin.write('quit\n')
  } catch {}
  try {
    d.proc.kill()
  } catch {}
  if (reason) log(`capture daemon stopped: ${reason}`)
}

/** 启动（或复用）常驻抓图进程；返回 {proc, pending} */
function startCaptureDaemon() {
  if (captureDaemon) return captureDaemon
  const script = path.join(__dirname, 'print_pets.ps1')
  if (!fs.existsSync(script)) return null
  let proc
  try {
    proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Daemon'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )
  } catch (error) {
    log(`capture daemon spawn failed ${error?.message || error}`)
    return null
  }
  const d = { proc, pending: new Map() }
  const rl = readline.createInterface({ input: proc.stdout })
  rl.on('line', (line) => {
    const text = String(line || '').trim()
    if (!text) return
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    const pending = d.pending.get(String(msg?.id))
    if (!pending) return
    d.pending.delete(String(msg.id))
    const items = Array.isArray(msg.items) ? msg.items : msg.items ? [msg.items] : []
    pending.resolve(items.filter((w) => w && Number.isFinite(Number(w.x)) && w.png))
  })
  const fail = (why) => {
    for (const pending of d.pending.values()) pending.resolve(null)
    d.pending.clear()
    if (captureDaemon === d) {
      captureDaemon = null
      log(`capture daemon gone (${why})`)
    }
  }
  proc.on('error', (error) => fail(error?.message || 'error'))
  proc.on('exit', (code) => fail(`exit ${code}`))
  proc.stderr.on('data', (buf) => {
    const text = String(buf || '').trim()
    if (text) log(`capture daemon stderr ${text.slice(0, 200)}`)
  })
  captureDaemon = d
  log('capture daemon started')
  return d
}

/** 让常驻进程抓一次；失败/超时返回 null，调用方回退一次性脚本 */
function daemonGrab(timeout = 3000) {
  const d = startCaptureDaemon()
  if (!d) return Promise.resolve(null)
  const id = String(++captureDaemonSeq)
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      d.pending.delete(id)
      if (captureDaemonIdle) clearTimeout(captureDaemonIdle)
      captureDaemonIdle = setTimeout(() => {
        if (captureDaemon && captureDaemon.pending.size === 0) stopCaptureDaemon('idle')
      }, CAPTURE_DAEMON_IDLE_MS)
      resolve(value)
    }
    d.pending.set(id, { resolve: finish })
    try {
      d.proc.stdin.write(`grab ${id}\n`)
    } catch (error) {
      log(`capture daemon write failed ${error?.message || error}`)
      finish(null)
      stopCaptureDaemon('write failed')
      return
    }
    setTimeout(() => {
      if (done) return
      log(`capture daemon timeout ${timeout}ms`)
      finish(null)
      stopCaptureDaemon('timeout')
    }, timeout)
  })
}

/**
 * Windows：用 PowerShell + PrintWindow 只拍 dsh-pet 的桌宠窗口（按标题精确匹配）。
 *
 * 为什么 Windows 必须这么走：整屏截图（desktopCapturer 的 screen 源）实测一次要
 * ~500ms，而且**全程阻塞 Electron 主线程**（16ms 心跳只跑了 2 拍），投掷飞行中触发
 * 重扫就是肉眼可见的卡顿。PrintWindow 跑在独立子进程里，主线程只负责解一张
 * 窗口大小的 PNG 再扫（实测量级 1~3ms）。
 *
 * 产物：每窗口一张 1:1 客户区 PNG，x/y 由 ClientToScreen 给出（PowerShell 进程非
 * DPI-aware，返回的就是 DIP，和 Electron 的 bounds 同一坐标系），所以 scale=1。
 */
async function probePetsPrintWindow(timeout = 8000) {
  const script = path.join(__dirname, 'print_pets.ps1')
  if (!fs.existsSync(script)) return []
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { timeout, windowsHide: true, maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error) {
          log(`pet window probe failed ${error?.message || error}`)
          resolve([])
          return
        }
        try {
          const parsed = JSON.parse(String(stdout).trim() || '[]')
          const list = Array.isArray(parsed) ? parsed : [parsed]
          resolve(list.filter((w) => w && Number.isFinite(Number(w.x)) && w.png))
        } catch {
          resolve([])
        }
      },
    )
  })
}

/**
 * 取当前屏幕上的画面，供 detectFish 扫蓝毛。
 *
 * - **Windows**：PrintWindow 逐窗口抓图（子进程，不占主线程；也只扫桌宠/DSH 窗口，
 *   不会把网页 UI 里的蓝字当成大肥鱼）。
 * - **macOS / Linux**：整屏截图（captureScreens）。这两边的桌面 helper 是
 *   `app.dock.hide()` 的透明窗口，System Events 只枚举 background only=false 的进程、
 *   ScreenCaptureKit 的窗口列表里也常常没有它，按标题找窗口永远找不到鱼。
 */
async function probePetWindows(timeout = 8000) {
  if (process.platform === 'win32') {
    // 优先常驻进程（实测 35~40ms）；它挂了/超时再回退一次性脚本（~1.4s）
    // 注意 [] 是「抓到了，但没有目标窗口」，不等于失败，别拿它回退
    const viaDaemon = await daemonGrab(Math.min(timeout, 3000))
    if (Array.isArray(viaDaemon)) return viaDaemon
    return probePetsPrintWindow(timeout)
  }
  return captureScreens(timeout)
}

/**
 * 在一张 PrintWindow 出来的 PNG 里找大肥鱼（蓝毛连通块）。
 * @returns {{hits:number, rect:object|null}|null} rect 是相对窗口客户区的 DIP 偏移
 */
function scanImage(img, kind = 'pet') {
  try {
    if (!img || typeof img.getSize !== 'function' || img.isEmpty()) return null
    const { width: w, height: h } = img.getSize()
    if (!w || !h) return null
    const bmp = img.toBitmap() // BGRA
    const mask = new Uint8Array(w * h)
    let hits = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const b = bmp[i]
        const g = bmp[i + 1]
        const r = bmp[i + 2]
        const a = bmp[i + 3]
        if (a < 40) continue
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        if (max === 0) continue
        const sat = (max - min) / max
        if (b > 110 && b - r > 35 && b >= g && sat > 0.22 && max > 70) {
          mask[y * w + x] = 1
          hits++
        }
      }
    }
    const blobs = []
    const seen = new Uint8Array(w * h)
    const stack = new Int32Array(w * h)
    for (let seed = 0; seed < mask.length; seed++) {
      if (!mask[seed] || seen[seed]) continue
      let top = 0
      stack[top++] = seed
      seen[seed] = 1
      let count = 0
      let bx0 = Infinity
      let bx1 = -1
      let by0 = Infinity
      let by1 = -1
      while (top > 0) {
        const idx = stack[--top]
        const x = idx % w
        const y = (idx - x) / w
        count++
        if (x < bx0) bx0 = x
        if (x > bx1) bx1 = x
        if (y < by0) by0 = y
        if (y > by1) by1 = y
        if (x > 0 && mask[idx - 1] && !seen[idx - 1]) {
          seen[idx - 1] = 1
          stack[top++] = idx - 1
        }
        if (x + 1 < w && mask[idx + 1] && !seen[idx + 1]) {
          seen[idx + 1] = 1
          stack[top++] = idx + 1
        }
        if (y > 0 && mask[idx - w] && !seen[idx - w]) {
          seen[idx - w] = 1
          stack[top++] = idx - w
        }
        if (y + 1 < h && mask[idx + w] && !seen[idx + w]) {
          seen[idx + w] = 1
          stack[top++] = idx + w
        }
      }
      const bw = bx1 - bx0 + 1
      const bh = by1 - by0 + 1
      // 桌面窗口里的她约 200×250 DIP；DSH 网页里的她会小一号、还可能被窗口边缘裁掉，
      // 而且那个窗口里 UI 的蓝色元素更多，所以按来源分开设阈值
      const page = kind === 'page'
      const minCount = page ? 1500 : 800
      const minW = page ? 50 : 80
      const minH = page ? 60 : 80
      const maxW = 460
      const maxH = 520
      if (count < minCount || bw < minW || bh < minH || bw > maxW || bh > maxH) continue
      blobs.push({ count, bx0, by0, bw, bh })
    }
    if (!blobs.length) return { hits, rect: null, rects: [] }
    // 画面里可能同时有多只大肥鱼：display=both 时网页一份、桌面一份，
    // 配置里也可能养了多只。每个合格连通块都留一个框，撞上任意一只就算捕到。
    blobs.sort((a, b) => b.count - a.count)
    const margin = 30
    const rects = blobs.map((b) => ({
      x: b.bx0 - margin,
      y: b.by0 - margin,
      w: Math.round(b.bw + margin * 2),
      h: Math.round(b.bh + margin * 2),
      hits: b.count,
    }))
    return { hits: rects[0].hits, rect: rects[0], rects }
  } catch (error) {
    log(`fish scan failed ${error?.message || error}`)
    return null
  }
}

/**
 * 从文件路径抓一张图再扫（Windows PrintWindow 的产物）
 * @returns {{hits:number, rect:object|null}|null}
 */
function scanPng(pngPath, kind = 'pet') {
  try {
    const { nativeImage } = require('electron')
    return scanImage(nativeImage.createFromPath(pngPath), kind)
  } catch {
    return null
  }
}

/**
 * 找大肥鱼：逐个桌宠窗口取内容，再在每张图里找「蓝毛连通块」。
 * 找到就把「窗口位置 + 块包围盒」换算成屏幕 DIP 当碰撞框；一个都没找到 = 她不在画面上（撞击必失手）。
 */
/** 一个框有超过一半落在自己窗口里 → 那是和大人本人，不是大肥鱼 */
function selfIsSameBlob(slot, self) {
  const x0 = Math.max(slot.x, self.x)
  const y0 = Math.max(slot.y, self.y)
  const x1 = Math.min(slot.x + slot.w, self.x + self.width)
  const y1 = Math.min(slot.y + slot.h, self.y + self.height)
  if (x1 <= x0 || y1 <= y0) return false
  const overlap = (x1 - x0) * (y1 - y0)
  return overlap > 0.5 * slot.w * slot.h
}

async function detectFish() {
  // WorkBuddy 版：真实捕鱼（像素扫描/捕捉/藏鱼）整体停用，只保留飞行 2 秒的纯视觉撒网动画。
  return fishPresent
  if (fishDetecting) return fishPresent
  // 正在拖动就别扫：整屏像素扫描是同步的（百万级像素 + 连通域），会阻塞主线程
  if (Date.now() - lastMoveAt < 300) return fishPresent
  if (!fishGateOpen) {
    // 没有大肥鱼插件 / 插件没启用 / 她把显示关了：完全不检测（省 CPU，也不会有幽灵判定）
    fishSlots = []
    fishPresent = false
    fishEverSeen = false
    fishDetectRect = null
    fishDetectAt = 0
    fishWindowCount = 0
    return false
  }
  fishDetecting = true
  try {
    const windows = await probePetWindows()
    fishWindowCount = windows.length
    const slots = []
    let lastHits = 0
    let foundHits = 0
    // 注意：下面循环变量也叫 win（捕获结果），会遮蔽模块级的和大人窗口。
    // 自己的位置必须在循环前取好，否则自替换永远拿到 null。
    // 用「本体矩形」而不是窗口矩形：窗口现在是一整块画布，气泡/菜单展开时会比本体大得多，
    // 拿整窗去排除会把画布覆盖范围内的大肥鱼全当成自己丢掉。
    const selfBounds = {
      x: petRect.x + 4,
      y: petRect.y + 4,
      width: Math.max(1, petRect.w - 8),
      height: Math.max(1, petRect.h - 8),
    }
    for (const win of windows) {
      const img = win.image || (win.png ? require('electron').nativeImage.createFromPath(win.png) : null)
      const scan = scanImage(img, win.kind)
      if (!scan) continue
      lastHits = Math.max(lastHits, scan.hits)
      const rects = scan.rects && scan.rects.length ? scan.rects : scan.rect ? [scan.rect] : []
      if (!rects.length) continue
      const sx = Number(win.scaleX) > 0 ? Number(win.scaleX) : 1
      const sy = Number(win.scaleY) > 0 ? Number(win.scaleY) : 1
      // 一张图里可能有好几只：每个框都进 slots，撞上任意一只就算捕到。
      // 但**和大人自己**也是蓝的（官服），整屏扫描会把他自己扫成"鱼"——
      // 那样一甩飞，网立刻撞在自己身上秒抓。凡是跟自己窗口大面积重合的框一律丢掉。
      for (const r of rects) {
        const slot = {
          x: Math.round(Number(win.x) + r.x * sx),
          y: Math.round(Number(win.y) + r.y * sy),
          w: Math.round(r.w * sx),
          h: Math.round(r.h * sy),
          hits: r.hits || scan.hits,
          from: win.kind === 'page' ? 'page' : 'desktop',
        }
        if (selfBounds && selfIsSameBlob(slot, selfBounds)) {
          log(`skip self-blob @${slot.x},${slot.y} ${slot.w}x${slot.h}`)
          continue
        }
        slots.push(slot)
        foundHits = Math.max(foundHits, r.hits || scan.hits)
      }
    }
    fishSlots = slots
    fishPresent = slots.length > 0
    if (fishPresent) {
      fishEverSeen = true
      fishDetectRect = slots[0]
    } else {
      fishDetectRect = null
    }
    const found = fishPresent ? { hits: foundHits, rect: fishDetectRect } : null
    fishDetectAt = Date.now()
    log(
      `fish detect windows=${windows.length} present=${fishPresent} everSeen=${fishEverSeen} ` +
        `hits=${fishPresent ? foundHits : lastHits} ` +
        `slots=${slots.map((x) => `${x.from}@${x.x},${x.y} ${x.w}x${x.h}`).join(' ') || 'none'}`,
    )
    try {
      writeState({
        fishDetect: {
          present: fishPresent,
          everSeen: fishEverSeen,
          hits: found ? found.hits : lastHits,
          windows: windows.length,
          slots: slots.map((x) => ({ from: x.from, x: x.x, y: x.y, w: x.w, h: x.h })),
          rect: fishDetectRect,
          surface: fishTarget?.surface || '',
          gate: fishGateOpen,
          at: Date.now(),
        },
      })
    } catch {}
    return fishPresent
  } catch (error) {
    log(`fish detect failed ${error?.message || error}`)
    return fishPresent
  } finally {
    fishDetecting = false
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 起飞前把大肥鱼的框准备好。
 *
 * 以前这里只是「顺手发一个异步扫描」就开始飞行：一次性 PowerShell 要 1.4 秒，
 * 飞快的那一下早就从她身上穿过去了。常驻进程把单次抓图压到 ~40ms 之后，
 * 这里可以真的等一等——最多等 maxWait，扫不出来就照旧用旧框飞。
 */
async function ensureFishSlots(maxWait = 400) {
  if (!fishGateOpen) return
  const t0 = Date.now()
  if (fishDetecting) {
    while (fishDetecting && Date.now() - t0 < maxWait) await sleep(15)
    return
  }
  if (fishDetectAt && Date.now() - fishDetectAt <= 400) return
  await Promise.race([detectFish(), sleep(maxWait)])
}

/** 撞上大肥鱼之前，网络是不是该自己先收网：把大肥鱼立刻关掉（不等插件轮询） */
async function hideFishNow() {
  // WorkBuddy 版：不隐藏任何真实大肥鱼（纯视觉玩法）
  return
  const origin = process.env.HEDAREN_DSHPET_ORIGIN
  const token = process.env.HEDAREN_DSHPET_TOKEN
  if (!origin || !token) return
  const petId = (fishTarget && fishTarget.petId) || 'main'
  try {
    const res = await fetch(`${origin}/api/dsh-pet-7340/pet-display?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-DSH-Pet-Token': token },
      body: JSON.stringify({ id: petId, display: 'none' }),
      signal: AbortSignal.timeout(4000),
    })
    log(`fish hide status=${res.status}`)
  } catch (error) {
    log(`fish hide failed ${error?.message || error}`)
  }
}

/**
 * 甩飞撞上大肥鱼：停下飞行 → 判定 → 播动作 + 说台词 + 写 state.fish。
 * forced 只给测试用（success / fail / reckless / hidden）。
 */
function runCapture(slot, svx, svy, forced) {
  // WorkBuddy 版：真实捕捉停用（无副作用），撒网只由飞行 2 秒的 netVisual 动画负责。
  return
  stopThrow()
  if (captureLock) return
  captureLock = true
  setTimeout(() => {
    captureLock = false
  }, 3200)

  const target = fishTarget || {}
  // visible 的语义：屏幕上此刻确实扫到了至少一只大肥鱼，才允许判定。
  // 不再区分「桌面窗口」还是「网页」——整屏截图之后两者本来就分不开，
  // 以前"只画在网页里 → 必定失败"的那条规则整个删掉。
  // 本轮从没扫到过她 = 可能刚启动、抓拍失败 → 按「在」处理，别让游戏直接没法玩。
  const visible = fishGateOpen && (fishSlots.length > 0 || !fishEverSeen)
  const speed = Math.hypot(Number(svx) || 0, Number(svy) || 0)
  let verdict
  if (forced === 'success') verdict = { result: 'success', chance: 0, reckless: false, speed }
  else if (forced === 'hidden') verdict = { result: 'hidden', chance: 1, reckless: true, speed }
  else if (forced === 'reckless') verdict = { result: 'fail', chance: 1, reckless: true, speed: Math.max(speed, 2600) }
  else if (forced === 'fail') verdict = { result: 'fail', chance: 1, reckless: false, speed: Math.min(speed, 900) }
  else verdict = capture.judgeCapture({ speed, visible })

  const now = Date.now()
  let anim = '跪舔'
  let face = '04-委屈'
  let line = capture.pickLine(capture.FAIL_LINES)
  if (verdict.result === 'success') {
    anim = '网住大肥鱼'
    face = '05-得意'
    line = capture.pickLine(capture.BRAG_LINES)
    // 她被网走了：立刻标记「不在」，别让旧的检测框在接下来几秒里又触发一次捕捉
    fishPresent = false
    fishEverSeen = true
    fishDetectRect = null
    fishSlots = []
    fishDetectAt = Date.now()
    void hideFishNow()
  } else if (verdict.result === 'hidden') {
    anim = '斗嘴'
    face = '06-恼怒'
    line = capture.pickLine(capture.HIDDEN_BLAME_LINES)
  } else if (verdict.reckless) {
    anim = '斗嘴'
    face = '06-恼怒'
    line = capture.pickLine(capture.BLAME_LINES)
  }

  try {
    writeState({
      // 不写 anim：捕捉演出由 state.capture 驱动，写 anim 会被工作态当成「用户点播」再播一遍
      say: { id: now + 1, text: line, face },
      capture: {
        at: now,
        result: verdict.result,
        anim,
        speed: Math.round(speed),
        facing: flightFacing || '',
      },
      fish: {
        at: now,
        result: verdict.result,
        speed: Math.round(speed),
        chance: Number((verdict.chance || 0).toFixed(3)),
        slot: slot ? { x: slot.x, y: slot.y, w: slot.w, h: slot.h } : null,
      },
    })
    log(
      `capture ${verdict.result} speed=${Math.round(speed)} chance=${Number(verdict.chance || 0).toFixed(2)} ` +
        `anim=${anim} line=${line.slice(0, 14)}`,
    )
  } catch (error) {
    log(`capture write failed ${error?.message || error}`)
  }
}

function throwWindow(vx, vy) {
  stopThrow(false) // 起飞前清场：不要把甩飞形象收掉
  if (!win) return
  // 起飞瞬间：坐标不是刚量的就立刻补一次（拖动时已经预扫过，通常这里就是新的）
  if (fishGateOpen && !fishDetecting && Date.now() - fishDetectAt > 600) void detectFish()
  log(
    `throw start speed=${Math.round(Math.hypot(Number(vx) || 0, Number(vy) || 0))} ` +
      `fishAge=${fishDetectAt ? Date.now() - fishDetectAt : -1}ms ` +
      `slots=${fishSlots.map((x) => `${x.from}@${x.x},${x.y} ${x.w}x${x.h}`).join(' ') || 'none'}`,
  )
  const bounds = { ...petRect }
  // 尺寸在飞行中可能变（甩飞形象比待机宽）：每帧现算边界，别用起飞那一刻的尺寸
  const area = screen.getDisplayMatching({
    x: bounds.x,
    y: bounds.y,
    width: bounds.w,
    height: bounds.h,
  }).workArea
  const minX = area.x
  const minY = area.y
  const startSize = intendedSize()
  const maxX0 = Math.max(minX, area.x + area.width - startSize.width)
  const maxY0 = Math.max(minY, area.y + area.height - startSize.height)
  let x = Math.min(Math.max(bounds.x, minX), maxX0)
  let y = Math.min(Math.max(bounds.y, minY), maxY0)
  let svx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, Number(vx) || 0))
  let svy = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, Number(vy) || 0))
  const throwStartedAt = Date.now()
  const fishPlayOnNow = readFishPlayEnabled() // 起飞瞬间锁定开关状态
  // 捕鱼阶段：off=未开启 / waiting=等待2秒 / fishing=定身捕鱼演出中 / done=已用掉
  let fishPhase = fishPlayOnNow ? 'waiting' : 'off'
  let savedVx = 0
  let savedVy = 0
  let last = Date.now()
  // 飞行朝向：向左飞就跟渲染端说一声，让它换成「面向左」的镜像素材
  let lastFacing = ''
  const sendFacing = (dir) => {
    flightFacing = dir
    if (dir === lastFacing) return
    lastFacing = dir
    try {
      win?.webContents.send('win:facing', dir)
    } catch {}
  }
  sendFacing(svx < 0 ? 'left' : svx > 0 ? 'right' : '')

  const bounce = (edge, speed) => {
    try {
      log(`bounce ${edge} speed=${Math.round(Math.abs(speed))}`)
      win?.webContents.send('win:bounce', edge, Math.abs(speed))
    } catch {}
  }

  // 飞行状态：每 ~100ms 播一次（渲染端据此保持「举网」形象，不靠猜）
  let lastStateAt = 0
  const publishThrowState = (active, dir) => {
    if (active) {
      const now = Date.now()
      if (now - lastStateAt < 100) return
      lastStateAt = now
    }
    try {
      win?.webContents.send('win:throwState', { active: Boolean(active), dir: dir || '' })
    } catch {}
  }

  throwTimer = setInterval(() => {
    if (!win) {
      stopThrow()
      return
    }
    const now = Date.now()
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
    last = now
    const { width, height } = intendedSize()

    // 捕鱼演出中：定身不动（跳过物理与落地判定），只保持位置同步，等动画播完再恢复
    if (fishPhase === 'fishing') {
      publishThrowState(false, '')
      petRect = { x: Math.round(x), y: Math.round(y), w: width, h: height }
      if (bubbleBox) bubbleBox = bubbleRectFor(bubbleBox.h || bubbleContentH)
      applyCanvas()
      return
    }

    const maxX = Math.max(minX, area.x + area.width - width)
    const maxY = Math.max(minY, area.y + area.height - height)
    svy += GRAVITY * dt
    x += svx * dt
    y += svy * dt

    if (x < minX) {
      x = minX
      if (svx < 0) bounce('left', svx)
      svx = Math.abs(svx) * RESTITUTION
    } else if (x > maxX) {
      x = maxX
      if (svx > 0) bounce('right', svx)
      svx = -Math.abs(svx) * RESTITUTION
    }
    if (y < minY) {
      y = minY
      if (svy < 0) bounce('top', svy)
      svy = Math.abs(svy) * RESTITUTION
    } else if (y > maxY) {
      y = maxY
      if (svy > 0) bounce('bottom', svy)
      svy = -Math.abs(svy) * RESTITUTION
      svx *= Math.max(0, 1 - FLOOR_FRICTION * dt)
    }

    if (Math.abs(svx) < 25 && Math.abs(svy) < 25 && y >= maxY - 1) {
      svx = 0
      svy = 0
    }
    // 方向变了（含撞墙回弹）就通知渲染端换朝向
    sendFacing(Math.abs(svx) < 120 ? (Math.abs(svy) < 120 ? '' : lastFacing) : svx < 0 ? 'left' : 'right')
    // WorkBuddy 版捕鱼玩法：飞行满 2 秒 → 原地定身 → 捕鱼判定 → 播「网住大肥鱼」→ 计数+1 → 恢复飞行。
    // 之前"动画从不触发"的根因：很多甩飞在 2 秒内就落地停住，条件永远等不到——现在到点必停。
    if (fishPhase === 'waiting' && (now - throwStartedAt) > FISH_PLAY_AFTER_MS) {
      fishPhase = 'fishing'
      savedVx = svx
      savedVy = svy
      svx = 0 // 定身：原地停住，跳过物理直到演出结束
      svy = 0
      const caught = Math.random() < FISH_CATCH_RATE
      const fishCount = caught ? recordFishCatch() : null
      try {
        win?.webContents.send('win:netVisual', { facing: lastFacing || (savedVx < 0 ? 'left' : 'right') })
        log(`fishing judge -> ${caught ? `caught (total=${fishCount})` : 'missed'} after 2s of flight`)
      } catch {}
      setTimeout(() => {
        try {
          writeState({
            say: {
              id: Date.now(),
              text: caught
                ? `哇！皇上网住了大肥鱼！累计捕鱼 ${fishCount ?? 1} 条（主子洪福齐天）`
                : '撒网半天……鱼跑了！空手而归，请主子再赏奴才一次机会。',
            },
          })
        } catch {}
        // 演出结束：动能减半恢复飞行，自然落地收尾；一次性玩法用掉即自动关
        svx = savedVx * 0.5
        svy = savedVy * 0.5
        fishPhase = 'done'
        writeFishPlayEnabled(false)
        fishGateOpen = false
        fishGateReason = '本次已捕一次，开关自动关闭（下次需手动开启）'
        log('fish play consumed (one-shot) -> auto closed')
      }, FISH_ANIM_MS)
    }

    // 还在飞：持续告诉渲染端「举网要继续」
    publishThrowState(Math.abs(svx) > 20 || Math.abs(svy) > 20, svx < 0 ? 'left' : 'right')
    // 只改本体位置；窗口尺寸/位置由 applyCanvas 统一跟随（气泡、菜单要一起框进去）
    petRect = { x: Math.round(x), y: Math.round(y), w: width, h: height }
    // 飞的时候气泡也得跟着：它现在贴在画布的固定偏移上，不重算就会被甩出画布
    if (bubbleBox) bubbleBox = bubbleRectFor(bubbleBox.h || bubbleContentH)
    applyCanvas()
    if (svx === 0 && svy === 0) stopThrow()
    // 硬超时兜底：8 秒（捕过鱼再加演出时长）还没停下就强制收尾，避免「举着网卡住/拖不动」
    else if (Date.now() - throwStartedAt > 8000 + (fishPhase === 'done' ? FISH_ANIM_MS : 0)) {
      log('throw force-stop after 8s')
      stopThrow()
    }
  }, 16)
}

function defaultPosition(width, height) {
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: Math.round(area.x + area.width - width - 28),
    y: Math.round(area.y + area.height - height - 40),
  }
}

/** 读取待机素材的着墨尺寸，让窗口一启动就是正确大小。 */
function canvasSize() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'animations', 'layout.json'), 'utf8'))
    const idle = raw['idle-static'] || raw.idle
    if (idle && Number(idle.width) > 0) {
      return {
        width: Number(idle.width),
        height: Number(idle.height),
        anchorX: Number(idle.anchorX) || Number(idle.width) / 2,
      }
    }
  } catch {}
  return { width: 198, height: 259, anchorX: 98 }
}

function baseWebPreferences(preload) {
  return {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    backgroundThrottling: false,
    // iframe 也要拿到 preload（气泡、菜单都是画在同一条渲染进程里的子框架）
    nodeIntegrationInSubFrames: true,
  }
}

function createPetWindow() {
  const state = readState()
  const canvas = canvasSize()
  // 0.75：整体缩小到 3/4，「100%」对应的就是缩小后的尺寸
  const scale = Math.max(0.7, Math.min(1.5, Number(state.scale) || 1)) * 0.75
  const inkW = Math.round(canvas.width * scale)
  const inkH = Math.round(canvas.height * scale)
  const anchorPx = Math.round(canvas.anchorX * scale) + 4
  currentMetrics = { width: canvas.width, height: canvas.height, anchorPx, scale }
  const width = inkW + 8
  const height = inkH + 8
  const fallback = defaultPosition(width, height)
  const hasX = state.x !== null && state.x !== undefined && Number.isFinite(Number(state.x))
  const hasY = state.y !== null && state.y !== undefined && Number.isFinite(Number(state.y))
  petRect = {
    x: hasX ? Number(state.x) : fallback.x,
    y: hasY ? Number(state.y) : fallback.y,
    w: width,
    h: height,
  }
  // 窗口是「画布」：比本体大一圈，位置也要按画布算（本体在画布里偏 (l, t)）
  canvasRect = baseCanvasRect()

  win = new BrowserWindow({
    width: canvasRect.w,
    height: canvasRect.h,
    x: canvasRect.x,
    y: canvasRect.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    show: false,
    // 画布四周的透明余量允许伸出屏幕（dsh-pet 同款），否则贴边时气泡/菜单会被裁掉
    enableLargerThanScreen: true,
    webPreferences: baseWebPreferences(path.join(__dirname, 'preload.js')),
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 画布整窗默认穿透，渲染端判定「指到东西了」再打开（见 setInteractive）
  interactive = null
  setInteractive(false)
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    log(`renderer[${level}] ${message} (${sourceId}:${line})`)
  })
  win.webContents.on('did-fail-load', (_event, code, desc) => log(`did-fail-load ${code} ${desc}`))
  win.webContents.on('did-finish-load', () => {
    log('pet did-finish-load')
    if (readState().visible !== false) {
      win.show()
      win.setAlwaysOnTop(true, 'screen-saver')
      win.moveTop()
    }
    applyCanvas()
    // 自检钩子：放一个 test-menu.flag 文件就自动在身体右上角弹一次菜单（量画布/截图用）
    if (fs.existsSync(path.join(STATE_DIR, 'test-menu.flag'))) {
      setTimeout(() => {
        if (!win || win.isDestroyed()) return
        openMenu(petRect.x + petRect.w - 20, petRect.y + 24)
        setTimeout(() => {
          log(
            `selftest menu box=${JSON.stringify(menuBox)} canvas=${JSON.stringify(canvasRect)} ` +
              `regions=${JSON.stringify(menuRegions)}`,
          )
        }, 800)
      }, 2200)
    }
  })
  {
    // 可选初始状态：常服（#changfu）、镜像（#mirror），测试用
    const hash = []
    win.loadFile(path.join(__dirname, 'pet.html'), hash.length ? { hash: hash.join('-') } : undefined)
    // 启动时把已保存的亏空阈值同步进 state，右键菜单才能显示当前值
    try {
      writeState({ jailThreshold: readJailThreshold() })
    } catch {}
  }
  win.once('ready-to-show', () => {
    if (readState().visible !== false) win.show()
  })
  // 窗口位置由我们算（画布 + 本体偏移），只有用户用别的手段移动过才需要反推
  win.on('moved', () => {
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    const ox = Math.round(petRect.x - canvasRect.x)
    const oy = Math.round(petRect.y - canvasRect.y)
    if (b.x !== canvasRect.x || b.y !== canvasRect.y) {
      canvasRect = { x: b.x, y: b.y, w: b.width, h: b.height }
      petRect = { ...petRect, x: b.x + ox, y: b.y + oy }
      layoutSig = ''
      applyCanvas()
    }
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      writeState({ x: Math.round(petRect.x), y: Math.round(petRect.y) })
    }, 250)
  })
  win.on('closed', () => {
    stopThrow()
    win = null
  })
}

/**
 * 聊天窗：惰性创建。用到才建，关掉就销毁——闲置时它不占渲染进程。
 * （气泡和右键菜单是画布上的 iframe，不再需要各自开窗口。）
 */
// ---- 和大人府邸（WorkBuddy 版）：独立设置窗口，替代 DSH 设置页里的府邸 tab ----
let mansionWin = null
function openMansion() {
  try {
    if (mansionWin && !mansionWin.isDestroyed()) {
      mansionWin.show()
      mansionWin.focus()
      return
    }
    mansionWin = new BrowserWindow({
      width: 720,
      height: 640,
      minWidth: 560,
      minHeight: 440,
      title: `和大人府邸${EDITION_SUFFIX}`,
      backgroundColor: '#181c26', // 与工作面板/聊天泡泡一致的深色底
      resizable: true,
      show: true,
      webPreferences: {
        ...baseWebPreferences(path.join(__dirname, 'preload.js')),
        nodeIntegrationInSubFrames: false,
      },
    })
    mansionWin.loadFile(path.join(__dirname, 'mansion.html'))
    mansionWin.on('closed', () => { mansionWin = null })
    mansionWin.webContents.on('did-finish-load', () => log('mansion.html loaded OK'))
    mansionWin.webContents.on('did-fail-load', (_e, code, desc) => log(`mansion load FAIL ${code} ${desc}`))
    log('mansion window created, allWindows=' + require('electron').BrowserWindow.getAllWindows().length)
  } catch (e) {
    log(`mansion open failed: ${e?.message || e}`)
  }
}

function ensureChatWindow() {
  if (chatWin && !chatWin.isDestroyed()) return chatWin
  chatWin = new BrowserWindow({
    width: CHAT_W,
    height: CHAT_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    show: false,
    webPreferences: baseWebPreferences(path.join(__dirname, 'preload.js')),
  })
  chatWin.setAlwaysOnTop(true, 'screen-saver')
  chatWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  chatWin.loadFile(path.join(__dirname, 'chat.html'))
  chatWin.on('blur', () => {
    // 点外面只收输入焦点，不关窗口；用户用 × 或 Esc 关
  })
  chatWin.on('closed', () => {
    chatWin = null
  })
  chatWin.webContents.on('did-finish-load', () => log('chat did-finish-load'))
  return chatWin
}

function createWindow() {
  createPetWindow()
  startPointerGuard()
  setupTray()
  startDaemonTrayWatcher()
  startStateWatcher()
  keepPetOnTop()
}

/**
 * 周期性把桌宠窗口重新顶到最上层。
 *
 * 症状：和大人还在动（渲染进程照常出帧、动画在跑），但鼠标点不到、拖不动——
 * 因为别的置顶窗口（dsh-pet 那只 924×821 的透明 helper、各种 alwaysOnTop 播放器、
 * 甚至另一个桌宠）被系统挪到了我们上面，点击全打在那个窗口上。
 * 托盘右键/菜单里做一次动作之所以能"恢复"，就是因为那条路径调了 win.moveTop()。
 * 这里每 4 秒自己顶一次；菜单/聊天窗开着时让它们保持在上面，不去抢。
 */
function keepPetOnTop() {
  if (keepTopTimer) clearInterval(keepTopTimer)
  keepTopTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return
    if (menuVisible()) return
    if (chatWin && !chatWin.isDestroyed() && chatWin.isVisible()) return
    if (thresholdWin && !thresholdWin.isDestroyed() && thresholdWin.isVisible()) return
    try {
      if (!win.isAlwaysOnTop()) log('topmost lost -> reassert')
      win.setAlwaysOnTop(true, 'screen-saver')
      win.moveTop()
    } catch {}
  }, 4000)
  keepTopTimer.unref?.()
}

/** 调试用：把每个窗口各截一张图后退出。 */

ipcMain.handle('state:read', () => readState())
ipcMain.handle('state:write', (_event, next) => writeState(next || {}))

// ---- 自动唤醒开关（SessionStart 拉起和大人）----
// 双数据源：
//   1) autostart.json —— hooks/autostart.js 每次拉起前都会读，改了立即生效；
//   2) ~/.workbuddy/settings.json 的 SessionStart hook —— 不注册则 WorkBuddy 压根不会触发拉起
//      （要重启 WorkBuddy 才生效）。开关同时管理这两处。
const AUTOSTART_FILE = () => path.join(STATE_DIR, 'autostart.json')
const WB_SETTINGS_FILE = () => path.join(process.env.WORKBUDDY_CONFIG_DIR || path.join(os.homedir(), '.workbuddy'), 'settings.json')
const PET_HOOK_SCRIPT = path.join(__dirname, '..', 'hooks', 'pet-hook.js')

function readAutostartEnabled() {
  try {
    const raw = JSON.parse(fs.readFileSync(AUTOSTART_FILE(), 'utf8'))
    return raw?.enabled !== false
  } catch {
    return true // 没写过 = 默认开（与 install.js 注册 hook 的默认行为一致）
  }
}

/** 找一个能当 hook 命令用的 node 可执行文件：WorkBuddy 内置 node 优先，PATH 兜底 */
function findNodeExe() {
  const candidates = []
  if (process.env.HEDAREN_NODE_EXE) candidates.push(process.env.HEDAREN_NODE_EXE)
  const binRoot = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions')
  try {
    for (const d of fs.readdirSync(binRoot)) {
      candidates.push(path.join(binRoot, d, process.platform === 'win32' ? 'node.exe' : 'node'))
    }
  } catch {}
  candidates.push(process.platform === 'win32' ? 'node.exe' : 'node')
  for (const c of candidates) {
    try { if (path.isAbsolute(c) && fs.existsSync(c)) return c } catch {}
  }
  return process.platform === 'win32' ? 'node.exe' : 'node'
}

function sessionStartHookState(cfg) {
  // 返回 { installed, hasForeign }：installed=我们的 pet-hook 是否已注册；hasForeign=SessionStart 里有没有别人的 hook
  const arr = cfg?.hooks?.SessionStart
  if (!Array.isArray(arr)) return { installed: false, hasForeign: false }
  const foreign = arr.some((g) => !(g?.hooks || []).some((h) => String(h?.command || '').includes('pet-hook.js')))
  return { installed: arr.some((g) => (g?.hooks || []).some((h) => String(h?.command || '').includes('pet-hook.js'))), hasForeign: foreign }
}

function readSettingsCfg() {
  try { return JSON.parse(fs.readFileSync(WB_SETTINGS_FILE(), 'utf8')) } catch { return null }
}

function writeSettingsCfg(cfg) {
  try {
    const file = WB_SETTINGS_FILE()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try { fs.copyFileSync(file, `${file}.hedaren-pet.bak`) } catch {}
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8')
    return { ok: true }
  } catch (error) {
    log(`autostart settings.json write failed: ${error?.message}`)
    return { ok: false, error: error?.message }
  }
}

/** 读自动唤醒状态：autostart.json 的开关 + settings.json 里 hook 是否在位 */
function readAutostartState() {
  const cfg = readSettingsCfg()
  return { enabled: readAutostartEnabled(), hookInstalled: sessionStartHookState(cfg).installed }
}

/** 设置自动唤醒：写 autostart.json（立即生效）+ 增删 settings.json 的 SessionStart hook（重启 WorkBuddy 生效） */
function writeAutostartEnabled(enabled) {
  try {
    fs.mkdirSync(path.dirname(AUTOSTART_FILE()), { recursive: true })
    fs.writeFileSync(AUTOSTART_FILE(), JSON.stringify({ enabled: Boolean(enabled), updatedAt: Date.now() }, null, 2), 'utf8')
  } catch (error) {
    log(`autostart.json write failed: ${error?.message}`)
    return { ok: false, error: error?.message }
  }
  const cfg = readSettingsCfg()
  if (!cfg) return { ok: true, note: 'settings.json 不存在或非法，hook 注册跳过' }
  if (!cfg.hooks || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks)) cfg.hooks = {}
  if (enabled) {
    const cmd = `${process.platform === 'win32' ? `"${findNodeExe()}"` : `'${findNodeExe()}'`} "${PET_HOOK_SCRIPT}" --event SessionStart`
    const state = sessionStartHookState(cfg)
    if (state.installed) {
      // 已在位：只刷新命令（node 路径可能变了），不动别人的
      for (const g of cfg.hooks.SessionStart) {
        for (const h of g?.hooks || []) {
          if (String(h?.command || '').includes('pet-hook.js')) h.command = cmd
        }
      }
    } else {
      cfg.hooks.SessionStart = [...(Array.isArray(cfg.hooks.SessionStart) ? cfg.hooks.SessionStart : []), { hooks: [{ type: 'command', command: cmd }] }]
      cfg.hooks.__hedaren_pet__ = []
    }
  } else {
    // 只摘除我们自己的条目，别人的 SessionStart hook 原样保留
    if (Array.isArray(cfg.hooks.SessionStart)) {
      cfg.hooks.SessionStart = cfg.hooks.SessionStart.filter((g) => !(g?.hooks || []).some((h) => String(h?.command || '').includes('pet-hook.js')))
      if (cfg.hooks.SessionStart.length === 0) delete cfg.hooks.SessionStart
    }
  }
  const r = writeSettingsCfg(cfg)
  return r.ok ? { ok: true, note: enabled ? 'hook 已注册，重启 WorkBuddy 后生效' : 'hook 已移除，重启 WorkBuddy 后生效' } : r
}

ipcMain.handle('autostart:read', () => readAutostartState())
ipcMain.handle('autostart:set', (_event, enabled) => ({ ...writeAutostartEnabled(Boolean(enabled)), enabled: Boolean(enabled) }))

// ---- 和大人府邸 IPC：用子进程跑 mansion-data.js（ESM），避免 CJS 主进程直接 import ----
function callMansionData(args = []) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    const finish = (ok, data) => {
      if (done) return
      done = true
      if (!ok) log(`mansion-data ${args.join(' ') || 'snapshot'} FAILED: ${String(err).slice(0, 2500)}`)
      resolve(ok ? data : { ok: false, error: String(err).slice(0, 500) || '府邸数据脚本无输出' })
    }
    try {
      const exe = process.execPath
      const script = path.join(__dirname, '..', 'mansion-data.js')
      const childEnv = {
        ...process.env,
        HEDAREN_PET_HOME: STATE_DIR,
        // 主进程的 process.execPath 是 electron.exe：必须强制以纯 Node 模式跑 ESM 脚本，
        // 否则 Electron 会把 mansion-data.js 当应用主入口加载，报 "join is not defined" 之类错误
        ELECTRON_RUN_AS_NODE: '1',
      }
      log(`mansion-data spawn: exe=${exe} script=${script} cwd=${path.join(__dirname, '..')} RUN_AS_NODE=${childEnv.ELECTRON_RUN_AS_NODE} NODE_OPTIONS=${childEnv.NODE_OPTIONS || '(none)'} execPathExists=${fs.existsSync(exe)} scriptExists=${fs.existsSync(script)}`)
      const child = spawn(exe, [script, ...args], {
        cwd: path.join(__dirname, '..'),
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout?.on('data', (d) => { out += d.toString() })
      child.stderr?.on('data', (d) => { err += d.toString(); log(`mansion-data stderr chunk: ${JSON.stringify(d.toString().slice(0, 800))}`) })
      child.on('error', (e) => { err += e.message; log(`mansion-data spawn error event: ${e.message} stack=${e.stack || '(none)'}`); finish(false) })
      child.on('close', () => {
        try { finish(true, JSON.parse(out)) } catch { finish(false) }
      })
      const t = setTimeout(() => { err += ' (timeout)'; finish(false) }, 15000)
      t.unref?.()
    } catch (e) {
      err += e.message
      finish(false)
    }
  })
}
ipcMain.handle('mansion:snapshot', async () => {
  const r = await callMansionData([])
  log(`mansion snapshot ok=${r?.ok}${r?.ok ? ` assets=${r?.treasury?.assets}` : ` error=${r?.error}`}`)
  return r
})
ipcMain.handle('mansion:resetMood', () => callMansionData(['reset-mood']))
ipcMain.handle('mansion:burnDiary', (_event, ids) => callMansionData(['burn-diary', ...(Array.isArray(ids) ? ids : [])]))
ipcMain.on('mansion:close', () => { if (mansionWin && !mansionWin.isDestroyed()) mansionWin.close() })

// 捕鱼玩法开关（纯视觉）：读取 / 切换 / 预览动画
ipcMain.handle('fishplay:read', () => ({ enabled: readFishPlayEnabled() }))
ipcMain.handle('fishplay:set', (_event, enabled) => {
  writeFishPlayEnabled(enabled)
  fishGateOpen = Boolean(enabled)
  fishGateReason = fishGateOpen ? '本地开关开启：飞行 2 秒播撒网动画（纯视觉）' : '本地开关关闭'
  return { enabled: fishGateOpen }
})
ipcMain.on('fishplay:preview', () => {
  // 手动预览一次撒网动画（从府邸/右键触发，验证开关效果）
  const facing = flightFacing || 'right'
  try { win?.webContents.send('win:netVisual', { facing }) } catch {}
})

ipcMain.on('pet:metrics', (_event, payload) => {
  if (!win || !payload) return
  const PAD = 4
  const scale = Math.max(0.7, Math.min(1.5, Number(payload.scale) || 1))
  const inkW = Math.max(1, Math.round(Number(payload.width) * scale))
  const inkH = Math.max(1, Math.round(Number(payload.height) * scale))
  const width = inkW + PAD * 2
  const height = inkH + PAD * 2
  // 帽子中心在本体矩形里的横向位置：换/缩放动作时以它为锚点，角色不会左右跳
  const anchorPx = Math.round((Number(payload.anchorX) || inkW / 2) * scale) + PAD
  const scaleChanged = Math.abs(scale - currentMetrics.scale) > 0.001
  const oldAnchorPx = currentMetrics.anchorPx ?? Math.round(petRect.w / 2)
  const anchorScreenX = petRect.x + oldAnchorPx
  currentMetrics = {
    width: Number(payload.width) || currentMetrics.width,
    height: Number(payload.height) || currentMetrics.height,
    anchorPx,
    scale,
  }
  log(
    `metrics ${payload.name || '?'} ink ${inkW}x${inkH} -> ${width}x${height} ` +
      `pet ${petRect.w}x${petRect.h} scale=${scale}`,
  )
  if (Math.abs(petRect.w - width) <= 2 && Math.abs(petRect.h - height) <= 2 && !scaleChanged) {
    return
  }
  // 本体以「脚底 + 帽子中心」为锚点改尺寸，角色不会跳
  petRect = {
    x: Math.round(anchorScreenX - anchorPx),
    y: Math.round(petRect.y + petRect.h - height),
    w: width,
    h: height,
  }
  if (bubbleBox) bubbleBox = bubbleRectFor(bubbleBox.h || bubbleContentH)
  applyCanvas()
  log(`metrics applied -> pet ${petRect.w}x${petRect.h}`)
})

ipcMain.on('win:throw', async (_event, vx, vy) => {
  if (!win) return
  log(`throw request vx=${Math.round(vx)} vy=${Math.round(vy)}`)
  // 起飞前等一次新鲜坐标（常驻进程下 ~40ms）：否则飞快了会从她身上穿过去
  const waitFrom = Date.now()
  await ensureFishSlots(400)
  const waited = Date.now() - waitFrom
  if (waited > 60) log(`throw waited ${waited}ms for fresh fish slots`)
  if (!win) return
  throwWindow(vx, vy)
})
ipcMain.on('win:throwSkip', (_event, info) => {
  log(
    `throw skipped settled=${info?.settled} settleMs=${info?.settleMs} ` +
      `stillMs=${info?.stillMs} dist=${info?.dist} speed=${info?.speed}`,
  )
})
ipcMain.on('win:stop', () => stopThrow())
ipcMain.on('win:ignore', (_event, ignore) => {
  if (!win) return
  // 现在窗口是「画布」，透明区域必须穿透
  setInteractive(Boolean(ignore) ? false : true)
})

/** 拖拽租约：拖的时候绝不能翻成穿透，否则 pointermove/pointerup 会断（dsh-pet 的 dragging 分支） */
ipcMain.on('win:drag', (_event, busy) => {
  dragBusy = Boolean(busy)
  if (dragBusy) {
    hoverMarginMs = 0
    setInteractive(true)
  }
})

/** 光标进入画布时渲染端会立刻叫一声：比等 60ms 轮询快，右键/点击不会「第一下没反应」 */
ipcMain.on('win:pointer-probe', () => pointerTick())

/** 切整窗是否吃鼠标：不吃时也继续转发移动事件（forward），作快路；权威判定见 pointerTick */
function setInteractive(on) {
  if (!win || win.isDestroyed()) return
  if (interactive === on) return
  interactive = on
  try {
    win.setIgnoreMouseEvents(!on, { forward: true })
  } catch {}
}

/**
 * 光标守卫（照 dsh-pet 的 pointer-target）：
 * 每 60ms 读一次真实光标，按「本体 / 菜单 / 余量」分区决定整窗穿不穿透。
 * 不能只靠 forward 鼠标钩子——Windows 上它会静默失效（一失效悬浮、拖拽、右键全哑）。
 */
const POINTER_POLL_MS = 60
const OFF_BODY_RELEASE_MS = 400
let hoverMarginMs = 0
let dragBusy = false
let pointerTimer = null

function inRect(p, r) {
  return Boolean(r) && p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h
}

function pointerTick() {
  if (!win || win.isDestroyed()) return
  const p = screen.getCursorScreenPoint()
  if (dragBusy) {
    hoverMarginMs = 0
    if (interactive !== true) setInteractive(true)
    return
  }
  const onPet = inRect(p, petRect)
  // 菜单只放行「主列 / 二级列」这两块，其余（菜单框里空着的地方、画布余量）继续穿透
  const onMenu = menuBox
    ? menuRegions.length
      ? menuRegions.some((r) => inRect(p, r))
      : inRect(p, menuBox)
    : false
  if (onPet || onMenu) {
    hoverMarginMs = 0
    if (interactive !== true) setInteractive(true)
    return
  }
  if (!inRect(p, canvasRect)) {
    hoverMarginMs = 0
    if (interactive !== false) setInteractive(false)
    return
  }
  // 余量区：先保持现状（可能正走向本体），连续停留超时才回到穿透
  hoverMarginMs += POINTER_POLL_MS
  if (hoverMarginMs >= OFF_BODY_RELEASE_MS && interactive !== false) setInteractive(false)
}

function startPointerGuard() {
  if (pointerTimer) clearInterval(pointerTimer)
  pointerTimer = setInterval(pointerTick, POINTER_POLL_MS)
  pointerTimer.unref?.()
}

function intendedSize() {
  const scale = currentMetrics.scale || 1
  return {
    width: Math.round((currentMetrics.width || 198) * scale) + 8,
    height: Math.round((currentMetrics.height || 259) * scale) + 8,
  }
}

function nudge(dx, dy) {
  if (!win) return
  const { width, height } = intendedSize()
  // 本体尺寸跟着当前动作的着墨范围走（换动作时窗口大小会变）
  if (Math.abs(petRect.w - width) > 2 || Math.abs(petRect.h - height) > 2) {
    petRect = { x: petRect.x, y: petRect.y + petRect.h - height, w: width, h: height }
  }
  petRect.x = Math.round(petRect.x + Number(dx || 0))
  petRect.y = Math.round(petRect.y + Number(dy || 0))
  // 气泡贴在本体头上：拖动时每帧跟着重算，否则它会留在原地并被画布裁掉
  if (bubbleBox) bubbleBox = bubbleRectFor(bubbleBox.h || bubbleContentH)
  applyCanvas()
}

ipcMain.on('win:move', (_event, dx, dy) => {
  lastMoveAt = Date.now()
  // 只在真的在飞的时候才收网：以前每个 mousemove 都调，等于每次多 3 条 IPC
  if (throwTimer) stopThrow()
  nudge(dx, dy)
})
ipcMain.on('win:hide', () => hidePet())
ipcMain.on('win:show', () => showPet())
ipcMain.on('app:quit', () => app.quit())

ipcMain.on('fish:prefetch', () => {
  // 拖拽开始就重扫一次：松手甩出去的那一刻，用的是「刚量过」的坐标
  if (!fishGateOpen) return
  if (!fishDetecting && Date.now() - fishDetectAt > 600) void detectFish()
})

ipcMain.on('menu:open', (_event, point) => {
  const cursor = screen.getCursorScreenPoint()
  openMenu(
    point && Number.isFinite(Number(point.x)) ? Number(point.x) : cursor.x,
    point && Number.isFinite(Number(point.y)) ? Number(point.y) : cursor.y,
  )
})
ipcMain.on('menu:close', () => hideMenu())
ipcMain.on('menu:resize', (_event, height) => {
  const value = Math.max(80, Math.min(760, Math.round(Number(height) || 0)))
  menuContentH = value
  if (!menuBox || menuBox.h === value) return
  const area = screen.getDisplayMatching({ x: menuBox.x, y: menuBox.y, width: menuBox.w, height: menuBox.h }).workArea
  const y = Math.min(menuBox.y, area.y + area.height - value - 6)
  menuBox = { ...menuBox, y: Math.max(area.y + 6, y), w: MENU_BOX_W, h: value }
  applyCanvas()
})
let thresholdWin = null

function openThresholdWindow() {
  hideMenu()
  if (thresholdWin && !thresholdWin.isDestroyed()) {
    thresholdWin.show()
    thresholdWin.focus()
    return
  }
  const width = 320
  const height = 190
  const b = { x: petRect.x, y: petRect.y, width: petRect.w, height: petRect.h }
  const area = screen.getDisplayMatching(b).workArea
  const x = Math.min(Math.max(area.x + 8, b.x + b.width + 8), area.x + area.width - width - 8)
  const y = Math.min(Math.max(area.y + 8, b.y - 40), area.y + area.height - height - 8)
  thresholdWin = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  thresholdWin.loadFile(path.join(__dirname, 'threshold.html'))
  let thresholdOpenedAt = Date.now()
  thresholdWin.once('ready-to-show', () => {
    thresholdOpenedAt = Date.now()
    thresholdWin.show()
    thresholdWin.focus()
    thresholdWin.webContents.send('jail:threshold-init', readJailThreshold())
  })
  thresholdWin.on('closed', () => {
    thresholdWin = null
  })
  thresholdWin.on('blur', () => {
    // 点外面就收起（跟右键菜单一致）；刚打开的那 700ms 内不算，否则一创建就自己关了
    if (Date.now() - thresholdOpenedAt < 700) return
    setTimeout(() => {
      if (thresholdWin && !thresholdWin.isDestroyed() && !thresholdWin.isFocused()) {
        thresholdWin.close()
      }
    }, 180)
  })
}

ipcMain.on('jail:threshold-save', (_event, value) => {
  const v = Math.round(Number(value) * 100) / 100
  if (!Number.isFinite(v) || v < 0.01 || v > 10000) return
  writeJailThreshold(v)
  log(`jail threshold -> ${v}`)
  writeState({ jailThreshold: v })
  if (thresholdWin && !thresholdWin.isDestroyed()) thresholdWin.close()
})

ipcMain.on('jail:threshold-close', () => {
  if (thresholdWin && !thresholdWin.isDestroyed()) thresholdWin.close()
})

ipcMain.on('menu:action', (_event, payload) => {
  const action = String(payload?.action || '')
  const data = payload?.data || {}
  if (action === 'scale') {
    writeState({ scale: Number(data.scale) || 1 })
    win?.webContents.send('pet:scale', Number(data.scale) || 1)
    return
  }
  if (action === 'settle') {
    const ms = clampSettle(data.ms)
    writeState({ throwSettleMs: ms })
    win?.webContents.send('pet:throwSettle', ms)
    log(`throw settle -> ${ms}ms`)
    return
  }
  hideMenu()
  if (action === 'play') {
    if (data.anim) writeState({ anim: { id: Date.now(), name: data.anim, loop: data.loop !== false } })
    if (data.text) writeState({ say: { id: Date.now(), text: String(data.text) } })
  } else if (action === 'face') {
    writeState({ say: { id: Date.now(), text: String(data.text || ''), face: data.face || '' } })
  } else if (action === 'treasury') {
    writeState({ treasury: { ...(readState().treasury || {}), refreshAt: Date.now() } })
  } else if (action === 'jail-threshold') {
    openThresholdWindow()
  } else if (action === 'chat') {
    openChat()
  } else if (action === 'mansion') {
    openMansion()
  } else if (action === 'memory') {
    // 记忆账本由插件端生成（主记忆/目录/分记忆与 token 账目），这里只点个「该出账本了」并由窗口展示
    writeState({ memory: { viewAt: Date.now() } })
    openChat()
  } else if (action === 'hide') {
    // 菜单里已经没有「先躲起来」，这里保留 IPC 兜底但不再暴露入口
    hidePet()
  } else if (action === 'quit') {
    app.quit()
  }
})
ipcMain.on('bubble:height', (_event, height) => {
  const h = Math.max(48, Math.min(BUBBLE_H, Math.round(Number(height) || BUBBLE_H)))
  if (Math.abs(h - bubbleContentH) < 1) return
  bubbleContentH = h
  syncSatellites()
})
ipcMain.on('chat:open', () => openChat())
ipcMain.on('chat:close', () => closeChat())

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
    }
  })
  // 窗口心跳：hooks/autostart.js（SessionStart 自动拉起）据此判断桌宠是否还活着
  const WINDOW_LOCK = path.join(STATE_DIR, 'window.lock')
  const writeWindowHeartbeat = () => {
    try { fs.writeFileSync(WINDOW_LOCK, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8') } catch {}
  }
  let heartbeatTimer = null
  app.whenReady().then(() => {
    createWindow()
    writeWindowHeartbeat()
    heartbeatTimer = setInterval(writeWindowHeartbeat, 5000)
  })
  app.on('window-all-closed', () => app.quit())
  app.on('will-quit', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    try { fs.rmSync(WINDOW_LOCK, { force: true }) } catch {}
    if (visibilityTimer) clearInterval(visibilityTimer)
    if (sayTimer) clearTimeout(sayTimer)
    if (keepTopTimer) clearInterval(keepTopTimer)
    stopCaptureDaemon('app quit')
    tray?.destroy()
  })
}


// 启动后预热一次捕鱼槽位：不预热的话第一次甩飞时 fishSlots 还是空的，
// 碰撞只能用配置推算的框（她可能已经被拖走），而且探测本身要花几百毫秒。
setTimeout(() => {
  if (fishGateOpen && !fishDetecting) void detectFish()
}, 5000)
