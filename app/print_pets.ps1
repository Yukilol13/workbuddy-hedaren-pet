param(
  [string]$Out = "$env:TEMP\heshen-pets",
  [switch]$Daemon
)

# 把 C# 编译一次、缓存成 DLL，之后每次只 -Path 加载。
# 实测：现场 Add-Type -TypeDefinition 要 ~100-250ms，缓存后加载几乎免费；
# 但 PowerShell 进程启动本身就要 ~900ms，所以真正省时间的是 -Daemon 常驻模式
# （插件端 spawn 一次后反复收发命令，单次抓图 ~50-150ms）。
Add-Type -AssemblyName System.Drawing

$CacheDir = Join-Path $env:TEMP 'heshen-pet-cache'
$DllPath = Join-Path $CacheDir 'HeshenPetWin.dll'

$Source = @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class PetWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public struct POINT { public int X, Y; }

  public class Item { public string kind; public string title; public int x, y, w, h; public string png; }

  /**
   * 把标题里含 needle 的可见窗口各自 PrintWindow 成 PNG，并记下客户区在屏幕上的位置（DIP）。
   * kind 用来区分「桌宠窗口」和「DSH 主窗口（网页里的宠物画在这里）」。
   */
  public static List<Item> Grab(string needle, string dir, string kind, int indexBase) {
    var items = new List<Item>();
    int index = indexBase;
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
      int w = r.Right - r.Left, hh = r.Bottom - r.Top;
      if (w < 40 || hh < 40) return true;
      var bmp = new System.Drawing.Bitmap(w, hh);
      var g = System.Drawing.Graphics.FromImage(bmp);
      IntPtr hdc = g.GetHdc();
      bool ok = PrintWindow(h, hdc, 2);
      g.ReleaseHdc(hdc);
      g.Dispose();
      if (ok) {
        string file = System.IO.Path.Combine(dir, kind + "-" + index + ".png");
        bmp.Save(file, System.Drawing.Imaging.ImageFormat.Png);
        items.Add(new Item { kind = kind, title = sb.ToString(), x = p.X, y = p.Y, w = w, h = hh, png = file });
        index++;
      }
      bmp.Dispose();
      return true;
    }, IntPtr.Zero);
    return items;
  }
}
"@

# 脚本改过（或 DLL 不存在 / 被清掉）就重编；脚本比 DLL 新 → 重编
$scriptPath = $PSCommandPath
if (-not $scriptPath) { $scriptPath = $MyInvocation.MyCommand.Path }
$needBuild = $true
if (Test-Path $DllPath) {
  try {
    $dllTime = (Get-Item $DllPath).LastWriteTimeUtc
    $srcTime = (Get-Item $scriptPath).LastWriteTimeUtc
    if ($dllTime -gt $srcTime) { $needBuild = $false }
  } catch { $needBuild = $true }
}

if ($needBuild) {
  New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
  $tmpDll = Join-Path $CacheDir ('HeshenPetWin.' + $PID + '.tmp.dll')
  Remove-Item $tmpDll -Force -ErrorAction SilentlyContinue
  try {
    Add-Type -TypeDefinition $Source -ReferencedAssemblies System.Drawing -OutputAssembly $tmpDll -OutputType Library
    Move-Item -Force $tmpDll $DllPath
  } catch {
    Remove-Item $tmpDll -Force -ErrorAction SilentlyContinue
    $DllPath = ''
  }
}

if ($DllPath) {
  try { Add-Type -Path $DllPath } catch { Add-Type -TypeDefinition $Source -ReferencedAssemblies System.Drawing }
} else {
  Add-Type -TypeDefinition $Source -ReferencedAssemblies System.Drawing
}

function Invoke-Grab {
  New-Item -ItemType Directory -Force -Path $Out | Out-Null
  Get-ChildItem $Out -Filter '*.png' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  $items = New-Object System.Collections.ArrayList
  foreach ($it in [PetWin]::Grab('dsh-pet 桌宠', $Out, 'pet', 0)) { [void]$items.Add($it) }
  foreach ($it in [PetWin]::Grab('DeepSeek Harness', $Out, 'page', 0)) { [void]$items.Add($it) }
  $list = @()
  foreach ($it in $items) {
    $list += [pscustomobject]@{ kind = $it.kind; title = $it.title; x = $it.x; y = $it.y; w = $it.w; h = $it.h; png = $it.png }
  }
  return ,$list
}

if ($Daemon) {
  # 常驻模式：stdin 每行一条命令 —— 「grab <id>」抓一次，「quit」退出。
  # stdout 每行一条 JSON：{"id":"<id>","items":[...]}（items 可能是空数组）
  # 输出统一 UTF-8：默认走系统 GBK 代码页，窗口标题里的中文到 Node 那边会变乱码
  try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
  $stdIn = [Console]::In
  $stdOut = [Console]::Out
  while ($true) {
    $line = $stdIn.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }
    if ($line -eq 'quit') { break }
    if ($line -like 'grab*') {
      $parts = $line.Split(' ')
      $id = if ($parts.Length -gt 1) { $parts[1] } else { '0' }
      $list = Invoke-Grab
      $payload = New-Object psobject
      $payload | Add-Member -NotePropertyName id -NotePropertyValue $id
      $payload | Add-Member -NotePropertyName items -NotePropertyValue @($list)
      $stdOut.WriteLine((ConvertTo-Json -InputObject $payload -Compress -Depth 5))
      $stdOut.Flush()
    }
  }
  exit 0
}

ConvertTo-Json -InputObject (Invoke-Grab) -Compress -Depth 4
