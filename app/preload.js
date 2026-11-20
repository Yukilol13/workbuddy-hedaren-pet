const { contextBridge, ipcRenderer } = require('electron')

/**
 * 渲染端桥。
 *
 * 同一个 preload 会在主框架和 iframe（气泡 / 右键菜单）里各跑一份
 * （窗口开了 nodeIntegrationInSubFrames）。差别在于：
 *   - 主框架（pet.html）负责画布排版、拖拽租约；
 *   - iframe 里只需要 readState / resizeBubble / resizeMenu / menuAction / onMenuOpened。
 * `win:layout`、`menu:opened` 这类主进程 push 只会送到主框架，所以主框架转发给 iframe。
 */
const isSubFrame = window.top !== window

/** 主框架：把一条 push 转给画布里的 iframe（备用通道，主要走 webFrameMain.send） */
function relayToFrames(channel, payload) {
  if (isSubFrame) return
  for (const frame of document.querySelectorAll('iframe')) {
    try {
      frame.contentWindow?.postMessage({ __hedarenRelay: channel, payload }, '*')
    } catch {}
  }
}

/** 订阅：每帧注册一次 ipcRenderer（主进程用 webFrameMain.send 精确投递到 iframe） */
function listen(channel, cb) {
  ipcRenderer.on(channel, (_event, ...args) => cb(...args))
}

contextBridge.exposeInMainWorld('hedaren', {
  isSubFrame,
  readState: () => ipcRenderer.invoke('state:read'),
  writeState: (next) => ipcRenderer.invoke('state:write', next),
  metrics: (payload) => ipcRenderer.send('pet:metrics', payload),
  moveBy: (dx, dy) => ipcRenderer.send('win:move', dx, dy),
  throwPet: (vx, vy) => ipcRenderer.send('win:throw', vx, vy),
  stopThrow: () => ipcRenderer.send('win:stop'),
  onBounce: (cb) => ipcRenderer.on('win:bounce', (_event, edge) => cb(edge)),
  onFacing: (cb) => ipcRenderer.on('win:facing', (_event, dir) => cb(dir)),
  onThrowEnd: (cb) => ipcRenderer.on('win:throwEnd', () => cb()),
  onThrowState: (cb) => ipcRenderer.on('win:throwState', (_event, state) => cb(state)),
  // WorkBuddy 版：飞行 2 秒触发的纯视觉撒网动画（无捕捉副作用）
  onNetVisual: (cb) => ipcRenderer.on('win:netVisual', (_event, info) => cb(info)),
  readFishPlay: () => ipcRenderer.invoke('fishplay:read'),
  setFishPlay: (enabled) => ipcRenderer.invoke('fishplay:set', enabled),
  previewFishPlay: () => ipcRenderer.send('fishplay:preview'),
  // 和大人府邸：读全量快照 / 重置颤栗值 / 烧日记 / 关窗
  mansionSnapshot: () => ipcRenderer.invoke('mansion:snapshot'),
  mansionResetMood: () => ipcRenderer.invoke('mansion:resetMood'),
  mansionBurnDiary: (ids) => ipcRenderer.invoke('mansion:burnDiary', ids),
  mansionClose: () => ipcRenderer.send('mansion:close'),
  // 自动唤醒开关：读状态 / 设置（写 autostart.json + 增删 SessionStart hook）
  readAutostart: () => ipcRenderer.invoke('autostart:read'),
  setAutostart: (enabled) => ipcRenderer.invoke('autostart:set', enabled),
  prefetchFish: () => ipcRenderer.send('fish:prefetch'),
  // 画布排版：本体在窗口里的偏移 + 气泡/菜单矩形（都是窗口内坐标）
  onLayout: (cb) => listen('win:layout', cb),
  // 拖拽租约：拖的时候主进程不许把窗口切成穿透
  setDragBusy: (busy) => ipcRenderer.send('win:drag', busy),
  // 光标进画布就催一次判定（比 60ms 轮询快，避免「第一下点/右键没反应」）
  probePointer: () => ipcRenderer.send('win:pointer-probe'),
  // 亏空阈值窗口
  onThresholdInit: (cb) => ipcRenderer.on('jail:threshold-init', (_event, value) => cb(value)),
  saveThreshold: (value) => ipcRenderer.send('jail:threshold-save', value),
  closeThreshold: () => ipcRenderer.send('jail:threshold-close'),
  setIgnore: (ignore) => ipcRenderer.send('win:ignore', ignore),
  hide: () => ipcRenderer.send('win:hide'),
  show: () => ipcRenderer.send('win:show'),
  quit: () => ipcRenderer.send('app:quit'),

  resizeBubble: (height) => ipcRenderer.send('bubble:height', height),
  openMenu: (point) => ipcRenderer.send('menu:open', point),
  closeMenu: () => ipcRenderer.send('menu:close'),
  resizeMenu: (height) => ipcRenderer.send('menu:resize', height),
  // 菜单里真正吃点击的矩形（主列 / 展开的二级列）
  menuRegions: (rects) => ipcRenderer.send('menu:regions', rects),
  menuAction: (payload) => ipcRenderer.send('menu:action', payload),
  onMenuOpened: (cb) => listen('menu:opened', () => cb()),
  onMenuSide: (cb) => listen('menu:side', (side) => cb(side)),

  openChat: () => ipcRenderer.send('chat:open'),
  closeChat: () => ipcRenderer.send('chat:close'),
  onScale: (cb) => ipcRenderer.on('pet:scale', (_event, value) => cb(value)),
  onThrowSettle: (cb) => ipcRenderer.on('pet:throwSettle', (_event, value) => cb(value)),
  throwSkip: (info) => ipcRenderer.send('win:throwSkip', info),
})
