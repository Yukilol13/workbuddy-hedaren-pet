/**
 * 与 dsh-pet（蓝毛小女仆 / 大肥鱼）打交道的桥。
 *
 * 只做三件事：
 *   1. 找到 dsh-pet 的宿主 HTTP 路由（/api/dsh-pet-7340/*）并带上 DSH 的访问凭据；
 *   2. 读它的配置，算「大肥鱼此刻在屏幕上的框」（宠物是网页里的浮层，位置由配置的
 *      角落 + 边距 + 尺寸 + DSH 窗口客户区换算而来）；
 *   3. 捕捉成功时把大肥鱼「关掉」（POST /pet-display display=none）。
 *
 * 凭据只从宿主的 connection 服务现取，不落盘、不写日志。
 */

import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const nodeRequire = createRequire(import.meta.url)

/**
 * DSH 桌面版把网页跑在自己的 Electron 里，会话 cookie/令牌在 session 里。
 * 能拿到 electron 的 session 就用 session.fetch —— 它自带这套凭据，
 * 等于以「这个窗口自己」的身份发请求，不用我们去猜令牌。
 */
function sessionFetch() {
  try {
    const electron = nodeRequire('electron')
    const ses = electron?.session?.defaultSession
    if (ses && typeof ses.fetch === 'function') return ses.fetch.bind(ses)
  } catch {}
  return null
}

function sessionCookieCount(origin) {
  try {
    const electron = nodeRequire('electron')
    const ses = electron?.session?.defaultSession
    if (!ses || typeof ses.cookies?.get !== 'function') return null
    return ses.cookies
      .get({ url: origin })
      .then((list) => (Array.isArray(list) ? list.length : 0))
      .catch(() => null)
  } catch {
    return null
  }
}

const ROUTE = 'dsh-pet-7340'

/** 大肥鱼在网页里的容器尺寸由 dsh-pet 配置给出（CSS px），这里按 1:1 用 */
const DEFAULT_SIZE = 462

function stripJsonc(text) {
  return String(text ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 枚举 Windows 顶层窗口，取 DSH 那个窗口的客户区（物理像素） */
const winprobe = nodeRequire('./app/winprobe.js')

/**
 * 所有标题含 needle 的可见窗口（跨平台）：
 * Windows 走 PowerShell + user32，macOS 走 osascript，Linux 走 wmctrl / xdotool。
 * 详见 app/winprobe.js。
 */
async function runWindowProbeAll(timeout = 6000, needle = 'DeepSeek Harness') {
  const result = await winprobe.listWindows(needle, { timeout })
  return { ok: Boolean(result.ok), tool: result.tool, reason: result.reason, windows: result.windows || [] }
}

/** 单个窗口（第一个标题命中的） */
async function runWindowProbe(timeout = 6000, needle = 'DeepSeek Harness') {
  const all = await runWindowProbeAll(timeout, needle)
  const first = all.windows[0]
  if (!first) return { ok: false, reason: all.reason || 'window-not-found' }
  return { ok: true, ...first }
}

export function createDshPetBridge({ ctx, dshHome, log = console } = {}) {
  const origin = String(process.env.DSH_WEB_URL || 'http://127.0.0.1:4348').replace(/\/+$/, '')
  const configFile = join(dshHome, 'dsh-pet', 'main-config.jsonc')
  let token = ''
  let tokenAt = 0
  let windowCache = { at: 0, value: null }
  let configCache = { at: 0, value: null }

  function authToken() {
    if (token && Date.now() - tokenAt < 120000) return token
    try {
      const conn = ctx?.get?.('connection', false)
      if (conn && typeof conn.authenticatedUrl === 'function') {
        const url = new URL(conn.authenticatedUrl(origin))
        token = url.searchParams.get('token') || ''
        tokenAt = Date.now()
      }
    } catch (error) {
      log.warn?.(`[hedaren-pet] 取 dsh-pet 凭据失败：${error?.message || String(error)}`)
    }
    return token
  }

  /** dsh-pet 挂在宿主 webServer 上的前缀路由 handler（/dsh-pet-7340） */
  function internalRoute() {
    try {
      const ws = ctx?.get?.('webServer', false)
      const prefixes = ws?.prefixes
      const entry = prefixes instanceof Map ? prefixes.get(`/${ROUTE}`) : prefixes?.[`/${ROUTE}`]
      if (entry && typeof entry.handler === 'function') return entry.handler
    } catch {}
    return null
  }

  /**
   * 直接在进程内调 dsh-pet 的路由：构造最小 req/res 喂给它的 handler。
   * 好处：不用过宿主 HTTP 层的 peer 鉴权（那层只认浏览器 cookie），
   * 而且 `/pet-display` 会走它自己的「写配置 + requestRestart」链路，桌面 Helper 会正经重启，
   * 不用我去杀进程。
   */
  async function internalCall(pathAndQuery, method = 'GET', body) {
    const handler = internalRoute()
    if (!handler) return null
    const { Readable } = await import('node:stream')
    const { EventEmitter } = await import('node:events')
    const text = body === undefined ? '' : JSON.stringify(body)
    const req = Readable.from(text ? [Buffer.from(text)] : [])
    req.url = pathAndQuery
    req.method = method
    req.headers = text
      ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }
      : {}
    const res = new EventEmitter()
    res.statusCode = 200
    res.headers = {}
    res.body = ''
    res.writableEnded = false
    res.destroyed = false
    res.setHeader = (k, v) => {
      res.headers[String(k).toLowerCase()] = v
    }
    res.getHeader = (k) => res.headers[String(k).toLowerCase()]
    res.writeHead = (code, headers) => {
      res.statusCode = code
      if (headers && typeof headers === 'object') {
        for (const [k, v] of Object.entries(headers)) res.headers[String(k).toLowerCase()] = v
      }
    }
    res.write = () => true
    res.end = (chunk) => {
      if (chunk) res.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      res.writableEnded = true
      res.emit('__done')
    }
    res.destroy = () => {
      res.destroyed = true
      res.emit('__done')
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        log.warn?.(`[hedaren-pet] 内部路由 ${pathAndQuery} 超时`)
        resolve()
      }, 8000)
      res.once('__done', () => {
        clearTimeout(timer)
        resolve()
      })
      Promise.resolve()
        .then(() => handler(req, res))
        .catch((error) => {
          log.warn?.(`[hedaren-pet] 内部路由失败：${error?.message || String(error)}`)
          res.emit('__done')
        })
    })
    let json
    try {
      json = JSON.parse(res.body)
    } catch {
      json = undefined
    }
    return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, text: res.body.slice(0, 300) }
  }

  async function api(rest, { method = 'GET', body, timeout = 4000 } = {}) {
    const internal = await internalCall(`/${ROUTE}/${rest}`, method, body)
    if (internal) return internal
    const t = authToken()
    const query = t ? `?token=${encodeURIComponent(t)}` : ''
    const url = `${origin}/api/${ROUTE}/${rest}${query}`
    const headers = {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(t ? { 'X-DSH-Pet-Token': t } : {}),
    }
    const sesFetch = sessionFetch()
    const doFetch = sesFetch || fetch
    const res = await doFetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    })
    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: res.status, ok: res.ok, json, text: text.slice(0, 400), via: sesFetch ? 'session' : 'fetch' }
  }

  /** 读配置：优先走接口（带凭据），失败直接读磁盘上的 main-config.jsonc */
  async function readConfig({ force = false } = {}) {
    if (!force && configCache.value && Date.now() - configCache.at < 4000) return configCache.value
    let config = null
    let source = 'api'
    try {
      const res = await api('config')
      if (res.ok && res.json && Array.isArray(res.json.pets)) config = res.json
    } catch (error) {
      log.warn?.(`[hedaren-pet] 读 dsh-pet 配置失败：${error?.message || String(error)}`)
    }
    if (!config) {
      source = 'file'
      try {
        config = JSON.parse(stripJsonc(await readFile(configFile, 'utf8')))
      } catch {
        config = null
      }
    }
    const value = { config, source, at: Date.now() }
    configCache = { at: Date.now(), value }
    return value
  }

  function pickPet(config) {
    const pets = Array.isArray(config?.pets) ? config.pets : []
    if (!pets.length) return null
    // 优先默认那只（id=main），否则第一只
    return pets.find((p) => String(p?.id) === 'main') || pets[0]
  }

  /**
   * 找「大肥鱼」类插件挂在宿主上的路由前缀：只有插件装着并启用时才有这个前缀。
   * dsh-pet 用 `/dsh-pet-7340`；同类插件（如 dsh-dafeiyu-pet）用 `/dsh-dafeiyu*`。
   */
  function petPlugins() {
    const found = []
    try {
      const ws = ctx?.get?.('webServer', false)
      const prefixes = ws?.prefixes
      const keys = prefixes instanceof Map ? [...prefixes.keys()] : Object.keys(prefixes || {})
      for (const key of keys) {
        const k = String(key)
        if (/\/dsh-pet/i.test(k)) found.push({ kind: 'dsh-pet', path: k })
        else if (/\/dsh-dafeiyu/i.test(k)) found.push({ kind: 'dsh-dafeiyu', path: k })
      }
    } catch {}
    return found
  }

  let gateCache = { at: 0, value: null }

  /**
   * 捕鱼门禁：**没有大肥鱼插件、插件没启用、或她把显示关了** 时返回 open=false，
   * 上层据此完全不做窗口探测与像素扫描。
   */
  async function gate({ force = false } = {}) {
    if (!force && gateCache.value && Date.now() - gateCache.at < 1500) return gateCache.value
    const plugins = petPlugins()
    const at = Date.now()
    const done = (value) => {
      gateCache = { at: Date.now(), value }
      return value
    }
    if (!plugins.length) {
      return done({ open: false, reason: 'no-plugin', plugin: '', petId: '', display: '', at })
    }
    const { config, source } = await readConfig({ force })
    const pet = pickPet(config)
    if (!pet) {
      return done({ open: false, reason: 'no-fish-pet', plugin: plugins[0].kind, petId: '', display: '', source, at })
    }
    const display = String(pet.display || 'web')
    const base = { plugin: plugins[0].kind, petId: String(pet.id), display, source, at }
    if (display === 'none') return done({ open: false, reason: 'fish-hidden', ...base })
    return done({ open: true, reason: 'ok', ...base })
  }

  const WINDOW_CACHE = new Map()

  /** 按标题找窗口，返回它的客户区（DIP）。helper = dsh-pet 的桌面宠物窗口 */
  async function windowRect({ force = false, needle = 'DeepSeek Harness' } = {}) {
    const cached = WINDOW_CACHE.get(needle)
    if (!force && cached && Date.now() - cached.at < 1500) return cached.value
    const value = await runWindowProbe(12000, needle)
    WINDOW_CACHE.set(needle, { at: Date.now(), value })
    return value
  }

  /** dsh-pet 桌面模式的宠物窗口：每只桌宠一个同标题窗口，全都返回 */
  let lastNonEmptyHelpers = null

  async function helperWindows({ force = false } = {}) {
    const cached = WINDOW_CACHE.get('dsh-pet 桌宠')
    if (!force && cached && Date.now() - cached.at < 1500) return cached.value
    const value = await runWindowProbeAll(12000, 'dsh-pet 桌宠')
    if (Array.isArray(value.windows) && value.windows.length > 0) {
      lastNonEmptyHelpers = value
    } else if (lastNonEmptyHelpers) {
      // 探测偶尔抓空（窗口正在重建）：沿用上一次的窗口位置，别把桌宠判成「不在」
      WINDOW_CACHE.set('dsh-pet 桌宠', { at: Date.now(), value: lastNonEmptyHelpers })
      return lastNonEmptyHelpers
    }
    WINDOW_CACHE.set('dsh-pet 桌宠', { at: Date.now(), value })
    return value
  }

  /** 兼容：第一个 helper 窗口 */
  async function helperWindow({ force = false } = {}) {
    const all = await helperWindows({ force })
    return all.windows[0] || { ok: false, reason: all.reason || 'window-not-found' }
  }

  /**
   * 大肥鱼在屏幕上的框（物理像素）。
   * 宠物是网页浮层：配置给的是「角 + 边距（CSS px）」和容器尺寸，换到屏幕坐标要把
   * DSH 窗口客户区、DPI 一起算进来。display 不含 web 时仍返回框（位置还在），visible=false。
   */
  async function target({ force = false } = {}) {
    // 门禁先查：没有大肥鱼插件 / 插件没开 / 她把显示关了 → 不探测窗口，直接判「不生效」
    const gateInfo = await gate({ force })
    if (!gateInfo.open) {
      return {
        ok: false,
        reason: gateInfo.reason,
        gate: gateInfo,
        visible: false,
        surface: '',
        helpers: [],
        at: Date.now(),
      }
    }
    // 串行探测：两个 PowerShell 同时启动时慢的那个会被超时掐掉，导致「明明有窗口却判 no-window」
    const { config, source } = await readConfig({ force })
    const helperList = await helperWindows({ force })
    const dsh = await windowRect({ force, needle: 'DeepSeek Harness' })
    const helpers = helperList.windows || []
    // winprobe 返回的是裸窗口（无 ok 字段），这里补齐，后面对 helper.ok 的判定才有意义
    const helper = helpers[0]
      ? { ...helpers[0], ok: true }
      : { ok: false, reason: helperList.reason || 'window-not-found' }
    const pet = pickPet(config)
    if (!pet) {
      return { ok: false, reason: 'no-pet', source, visible: false, gate: gateInfo }
    }
    const display = String(pet.display || 'web')
    const wantsDesktop = display === 'desktop' || display === 'both'
    // 宠物画在 dsh-pet 的桌面 Helper 窗口里（display 含 desktop 时），否则才在 DSH 网页里
    const win = wantsDesktop && helper.ok ? helper : dsh.ok ? dsh : helper
    const surface = wantsDesktop ? 'desktop' : 'web'
    const size = Number(pet.size) > 0 ? Number(pet.size) : DEFAULT_SIZE
    const position = pet.position && typeof pet.position === 'object' ? pet.position : {}
    const corner = String(position.corner || 'top-right')
    const marginX = Number(position.marginX) || 0
    const marginY = Number(position.marginY) || 0
    if (!win.ok) {
      return {
        ok: false,
        reason: win.reason || 'no-window',
        pet: { id: pet.id, display, size },
        source,
        visible: false,
        surface,
        gate: gateInfo,
        helper: helper.ok ? { x: helper.x, y: helper.y, w: helper.w, h: helper.h, title: helper.title || '' } : null,
      }
    }
    const dpi = Number(win.dpi) > 0 ? Number(win.dpi) : 1
    // 探测出来的窗口客户区是 DIP（探测进程不带 DPI 感知，Windows 直接给逻辑像素），
    // 配置里的边距与尺寸也是 CSS px，和 Electron 的窗口坐标同为 DIP，于是这里不做换算。
    // 宠物盒是 16:9 的舞台（640×360 画布），宽度 = size，高度按 9/16 推出。
    const w = Math.round(size)
    const h = Math.round((size * 9) / 16)
    const right = win.x + win.w
    const left = win.x
    let x
    if (corner.includes('left')) x = Math.round(left + marginX)
    else x = Math.round(right - marginX - w)
    const y = Math.round(win.y + marginY)
    const rect = { x, y, w, h }
    // desktop（含 both）下，宠物是相对**屏幕工作区**按角落摆的，拿 DSH 窗口当尺子
    // 会把明明在屏幕上的她判成「不在显示范围」。这个表面的真实可见性由窗口侧
    // 的像素判定负责：屏幕上扫到她，才算看见。
    const inWindow =
      surface === 'desktop' ||
      (rect.x + rect.w > win.x && rect.x < win.x + win.w && rect.y + rect.h > win.y && rect.y < win.y + win.h)
    return {
      ok: true,
      pet: { id: pet.id, name: pet.name || '', display, size },
      // 配置推算的框只是兜底：宠物会走、会被拖，真正的位置由窗口那侧扫像素决定
      rect,
      window: { x: win.x, y: win.y, w: win.w, h: win.h, dpi, title: win.title || '' },
      helper: helper.ok ? { x: helper.x, y: helper.y, w: helper.w, h: helper.h, title: helper.title || '' } : null,
      helpers: helpers.map((h) => ({ x: h.x, y: h.y, w: h.w, h: h.h, title: h.title || '' })),
      dshWindow: dsh.ok ? { x: dsh.x, y: dsh.y, w: dsh.w, h: dsh.h } : null,
      surface,
      visible: display !== 'none' && inWindow,
      inWindow,
      gate: gateInfo,
      source,
      at: Date.now(),
    }
  }

  /** 退路：直接改 dsh-pet 的配置文件（页/桌面端下次读配置时生效） */
  async function writeDisplayToFile(petId, display) {
    try {
      const raw = await readFile(configFile, 'utf8')
      const config = JSON.parse(stripJsonc(raw))
      const pets = Array.isArray(config.pets) ? config.pets : []
      let hit = false
      for (const p of pets) {
        if (String(p?.id) === petId) {
          p.display = display
          hit = true
        }
      }
      if (!hit) return false
      await mkdir(dirname(configFile), { recursive: true })
      await writeFile(configFile, JSON.stringify(config, null, 2), 'utf8')
      configCache = { at: 0, value: null }
      return true
    } catch (error) {
      log.warn?.(`[hedaren-pet] 写 dsh-pet 配置失败：${error?.message || String(error)}`)
      return false
    }
  }

  /** 关掉大肥鱼（display=none）：先走接口，接口没权限就改配置文件 */
  async function hide() {
    const { config } = await readConfig({ force: true })
    const pet = pickPet(config)
    const id = pet ? String(pet.id) : 'main'
    let res = null
    try {
      res = await api('pet-display', { method: 'POST', body: { id, display: 'none' }, timeout: 6000 })
    } catch (error) {
      log.warn?.(`[hedaren-pet] 关闭大肥鱼接口失败：${error?.message || String(error)}`)
    }
    if (res && res.ok) {
      log.info?.(`[hedaren-pet] 大肥鱼已关闭（走宿主内部路由 /pet-display，Helper 会正经重启）`)
      return { ok: true, via: 'internal', id, body: res.json ?? res.text }
    }
    const fileOk = await writeDisplayToFile(id, 'none')
    log.warn?.(`[hedaren-pet] 关闭大肥鱼接口 ${res ? res.status : 'err'}，改配置文件${fileOk ? '已写入（下次读配置生效）' : '也失败'}`)
    return { ok: fileOk, via: fileOk ? 'file' : 'none', id, apiStatus: res ? res.status : 0, body: res ? res.json ?? res.text : '' }
  }

  /** 重新显示（调试用） */
  async function show(display = 'web') {
    const { config } = await readConfig({ force: true })
    const pet = pickPet(config)
    const id = pet ? String(pet.id) : 'main'
    let res = null
    try {
      res = await api('pet-display', { method: 'POST', body: { id, display }, timeout: 6000 })
    } catch (error) {
      log.warn?.(`[hedaren-pet] 恢复大肥鱼接口失败：${error?.message || String(error)}`)
    }
    if (res && res.ok) return { ok: true, via: 'api', id, body: res.json ?? res.text }
    const fileOk = await writeDisplayToFile(id, display)
    return { ok: fileOk, via: fileOk ? 'file' : 'none', id, apiStatus: res ? res.status : 0, body: res ? res.json ?? res.text : '' }
  }

  /** 读 dsh-pet 的状态快照（宠物当前位置、显示、锁/睡等都在这里） */
  async function petState() {
    const res = await api('state', { timeout: 3000 })
    return { ok: res.ok, status: res.status, state: res.json ?? null, text: res.text }
  }

  /** 排查凭据：只回状态码与是否带凭据，绝不回令牌本身 */
  async function probeAuth() {
    let authUrl = ''
    try {
      const conn = ctx?.get?.('connection', false)
      if (conn && typeof conn.authenticatedUrl === 'function') authUrl = String(conn.authenticatedUrl(origin))
    } catch {}
    const t = authToken()
    const attempts = []
    const sesFetch = sessionFetch()
    const cookieCount = await sessionCookieCount(origin)
    // webServer 里挂了哪些前缀路由（看 dsh-pet 的 /pet-display 能不能直接摸到 handler）
    try {
      const ws = ctx?.get?.('webServer', false)
      const prefixes = ws?.prefixes
      const keys = prefixes instanceof Map ? [...prefixes.keys()] : Object.keys(prefixes || {})
      attempts.push(`prefixes=[${keys.join('|')}]`)
      const exact = ws?.exact
      const ekeys = exact instanceof Map ? [...exact.keys()] : Object.keys(exact || {})
      attempts.push(`exact=${ekeys.length}`)
    } catch (error) {
      attempts.push(`prefixesErr=${String(error?.message || error).slice(0, 40)}`)
    }
    attempts.push(`session=${sesFetch ? 'yes' : 'no'}`)
    attempts.push(`cookies=${cookieCount === null ? '?' : cookieCount}`)
    attempts.push(`token=${t ? 'yes' : 'no'}`)
    const tryFetch = async (label, url, headers) => {
      try {
        const doFetch = sesFetch || fetch
        const res = await doFetch(url, { headers, signal: AbortSignal.timeout(3000) })
        const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
        attempts.push(`${label}=${res.status}${cookies.length ? `(set-cookie:${cookies.length})` : ''}`)
        return { res, cookies }
      } catch (error) {
        attempts.push(`${label}=err(${String(error?.message || error).slice(0, 24)})`)
        return null
      }
    }
    const base = `${origin}/api/${ROUTE}/state`
    await tryFetch('api-plain', base, {})
    if (t) {
      const entry = await tryFetch('entry', `${origin}/?token=${encodeURIComponent(t)}`, {})
      const cookieHeader = entry && entry.cookies.length ? entry.cookies.map((c) => c.split(';')[0]).join('; ') : ''
      attempts.push(`cookieLen=${cookieHeader.length}`)
      if (cookieHeader) await tryFetch('api-cookie', base, { cookie: cookieHeader })
      await tryFetch('api-query', `${base}?token=${encodeURIComponent(t)}`, {})
    }
    return {
      origin,
      authUrlKeys: authUrl ? [...new URL(authUrl).searchParams.keys()] : [],
      authUrlHasToken: Boolean(authUrl && new URL(authUrl).searchParams.get('token')),
      tokenLength: t.length,
      attempts,
      envKeys: Object.keys(process.env)
        .filter((k) => /TOKEN|DSH|WEB|SECRET|ENTRY|URL/i.test(k))
        .map((k) => `${k}:${String(process.env[k] ?? '').length}`),
    }
  }

  return { origin, api, readConfig, pickPet, windowRect, helperWindow, helperWindows, target, gate, petPlugins, hide, show, petState, probeAuth }
}

export { runWindowProbe }
