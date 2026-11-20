/**
 * 跨平台窗口探测：按「标题包含某段文字」找到可见窗口，返回它们的屏幕位置与尺寸（DIP）。
 *
 * 三个平台各走一条路：
 * - **Windows**：PowerShell + user32（`EnumWindows` / `GetClientRect` / `ClientToScreen`）。
 *   探测进程不带 DPI 感知，拿到的是逻辑像素（= Electron 的 DIP），无需换算。
 * - **macOS**：`osascript` + System Events（需要「辅助功能」授权）。返回的是屏幕点（point），
 *   与 DIP 等价；无授权时报 `need-macos-permission`。
 * - **Linux**：`wmctrl -lG`（X11）。坐标是**物理像素**，HiDPI 下要按调用方给的 `scale` 折算成 DIP；
 *   没有 wmctrl 时退回 `xdotool`，两者都没有时报 `no-window-tool`。Wayland 下窗口枚举基本不可用。
 *
 * 本模块是纯 Node（只用 child_process），插件进程和桌宠进程都能直接用，不依赖 Electron。
 *
 * @module dsh-hedaren-pet/app/winprobe
 */

const { execFile } = require('node:child_process')

/** Windows：把所有标题含 needle 的可见窗口的客户区（逻辑像素）列出来 */
const PS_ALL = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class HedarenWinProbe {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public struct POINT { public int X, Y; }
  public static string FindAll(string needle) {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLengthW(h);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowTextW(h, sb, sb.Capacity);
      if (sb.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;
      RECT r; POINT p = new POINT();
      if (!GetClientRect(h, out r)) return true;
      if (!ClientToScreen(h, ref p)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      double dpi = GetDpiForWindow(h) / 96.0;
      list.Add("{\"pid\":" + pid + ",\"title\":\"" + sb.ToString().Replace("\\", "\\\\").Replace("\"", "\\\"") + "\",\"x\":" + p.X + ",\"y\":" + p.Y + ",\"w\":" + (r.Right - r.Left) + ",\"h\":" + (r.Bottom - r.Top) + ",\"dpi\":" + dpi.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture) + "}");
      return true;
    }, IntPtr.Zero);
    return "{\"ok\":true,\"windows\":[" + string.Join(",", list) + "]}";
  }
}
"@
[HedarenWinProbe]::FindAll('__NEEDLE__')
`

/** macOS：System Events 列出所有普通进程的窗口（进程名、标题、位置、尺寸），target 用 tab 分隔 */
const APPLESCRIPT = String.raw`
set outText to ""
tell application "System Events"
  set procs to every process whose background only is false
  repeat with p in procs
    try
      set pname to (name of p) as text
      repeat with w in (every window of p)
        try
          set wname to (name of w) as text
          set wpos to position of w
          set wsz to size of w
          set wx to (item 1 of wpos) as text
          set wy to (item 2 of wpos) as text
          set ww to (item 1 of wsz) as text
          set wh to (item 2 of wsz) as text
          set outText to outText & pname & tab & wname & tab & wx & tab & wy & tab & ww & tab & wh & linefeed
        end try
      end repeat
    end try
  end repeat
end tell
return outText
`

function run(file, args, { timeout = 6000, maxBuffer = 4 << 20 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

async function probeWin32(needle, timeout) {
  const script = PS_ALL.replace('__NEEDLE__', needle.replace(/'/g, "''"))
  const r = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout },
  )
  if (r.error) return { ok: false, tool: 'powershell', reason: `probe-failed: ${r.error.message.slice(0, 120)}`, windows: [] }
  try {
    const parsed = JSON.parse(r.stdout.trim() || '{}')
    const windows = Array.isArray(parsed.windows) ? parsed.windows : []
    for (const w of windows) w.dpi = Number(w.dpi) > 0 ? Number(w.dpi) : 1
    return { ok: windows.length > 0, tool: 'powershell', windows }
  } catch {
    return { ok: false, tool: 'powershell', reason: 'probe-bad-json', windows: [] }
  }
}

async function probeDarwin(needle, timeout) {
  const r = await run('osascript', ['-e', APPLESCRIPT], { timeout, maxBuffer: 8 << 20 })
  if (r.error) {
    const soft = /-1743|not allowed|not authorized|assistive/i.test(`${r.stderr} ${r.error.message}`)
    return {
      ok: false,
      tool: 'osascript',
      reason: soft ? 'need-macos-permission' : `probe-failed: ${r.error.message.slice(0, 120)}`,
      windows: [],
    }
  }
  const windows = []
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 6) continue
    const [proc, title, x, y, w, h] = parts
    if (!title.includes(needle)) continue
    const rect = { x: Number(x), y: Number(y), w: Number(w), h: Number(h) }
    if (![rect.x, rect.y, rect.w, rect.h].every((v) => Number.isFinite(v))) continue
    if (rect.w < 20 || rect.h < 20) continue
    windows.push({ ...rect, title, app: proc, dpi: 1 })
  }
  return { ok: windows.length > 0, tool: 'osascript', windows }
}

async function probeLinux(needle, timeout, scale) {
  const r = await run('wmctrl', ['-lG'], { timeout })
  if (!r.error) {
    const windows = []
    for (const line of r.stdout.split(/\r?\n/)) {
      // 0x03a00007  0  100  50  800  600  hostname  <title...>
      const m = line.match(/^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
      if (!m) continue
      const title = m[8]
      if (!title.includes(needle)) continue
      const w = Number(m[5])
      const h = Number(m[6])
      if (!(w > 20 && h > 20)) continue
      // wmctrl 给的是物理像素，HiDPI 要折成 DIP
      const s = scale > 0 ? scale : 1
      windows.push({
        x: Math.round(Number(m[3]) / s),
        y: Math.round(Number(m[4]) / s),
        w: Math.round(w / s),
        h: Math.round(h / s),
        title,
        id: m[1],
        dpi: s,
      })
    }
    return { ok: windows.length > 0, tool: 'wmctrl', windows }
  }

  // wmctrl 没有：退回 xdotool（逐个查标题与几何）
  const search = await run('xdotool', ['search', '--name', needle], { timeout })
  if (search.error) {
    return {
      ok: false,
      tool: 'none',
      reason: 'no-window-tool: 请安装 wmctrl（或 xdotool）',
      windows: [],
    }
  }
  const ids = search.stdout.split(/\r?\n/).map((v) => v.trim()).filter(Boolean)
  const windows = []
  const s = scale > 0 ? scale : 1
  for (const id of ids.slice(0, 8)) {
    const geo = await run('xdotool', ['getwindowgeometry', '--shell', id], { timeout })
    const name = await run('xdotool', ['getwindowname', id], { timeout })
    const vals = {}
    for (const line of geo.stdout.split(/\r?\n/)) {
      const m = line.match(/(X|Y|WIDTH|HEIGHT)=(\d+)/)
      if (m) vals[m[1]] = Number(m[2])
    }
    if (![vals.X, vals.Y, vals.WIDTH, vals.HEIGHT].every((v) => Number.isFinite(v))) continue
    windows.push({
      x: Math.round(vals.X / s),
      y: Math.round(vals.Y / s),
      w: Math.round(vals.WIDTH / s),
      h: Math.round(vals.HEIGHT / s),
      title: name.stdout.trim(),
      id,
      dpi: s,
    })
  }
  return { ok: windows.length > 0, tool: 'xdotool', windows }
}

/**
 * 找到标题含 needle 的可见窗口。
 * @param {string} needle 标题子串
 * @param {{timeout?:number, scale?:number}} [options] scale 只对 Linux 有意义（物理像素→DIP）
 * @returns {Promise<{ok:boolean, tool:string, reason?:string, windows:Array}>}
 */
/** 丢弃「太小」和「被最小化到屏幕外」的窗口：它们的位置没有意义 */
function usableWindows(list) {
  return list.filter(
    (w) =>
      Number.isFinite(w.x) &&
      Number.isFinite(w.y) &&
      Number.isFinite(w.w) &&
      Number.isFinite(w.h) &&
      w.w >= 40 &&
      w.h >= 40 &&
      w.x > -10000 &&
      w.y > -10000,
  )
}

async function listWindows(needle, { timeout = 6000, scale = 1 } = {}) {
  let result
  if (process.platform === 'darwin') result = await probeDarwin(needle, timeout)
  else if (process.platform === 'win32') result = await probeWin32(needle, timeout)
  else result = await probeLinux(needle, timeout, scale)
  const windows = usableWindows(result.windows || [])
  return { ...result, windows, ok: windows.length > 0 }
}

/** 用来区分「探测本身失败」和「确实没有这个窗口」 */
function isPlatformSupported() {
  return process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux'
}

module.exports = { listWindows, isPlatformSupported }
