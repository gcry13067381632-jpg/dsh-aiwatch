# agent-input.ps1 (v4) — 低开销「人是否在操作电脑」信号 + 全局热键
#   · 每 500ms 读一次系统输入计数器（一次 P/Invoke，微秒级）；配了热键时改为每 80ms 轮询键位
#   · 只在「有新输入」或「前台窗口变了」时才输出一行；另每 10 秒心跳一行
#   · 前台进程名做了缓存（同一窗口只查一次进程表），进一步省 CPU
#   · 热键用 GetAsyncKeyState 轮询（不用消息钩子：不用消息循环、不占用钩子名额、误触为零），
#     只在"所有键同时按下"的上升沿输出一行 {"hotkey":"<写法>"}，交给监听脚本落盘、插件去唤醒
# 输出行 JSON: {"ts":毫秒,"idleMs":距上次键鼠输入毫秒,"fg":"前台进程名","title":"窗口标题","inputTick":原始输入计数}
#   热键触发时: {"ts":毫秒,"hotkey":"Ctrl+Alt+A","fg":"...","idleMs":...}
# 用法: pwsh -File agent-input.ps1 -Hotkey "Ctrl+Alt+A"

param([string]$Hotkey = '')

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;

public class DshWin4 {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int id);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);

  static Dictionary<IntPtr, string> _cache = new Dictionary<IntPtr, string>();
  static uint Tick32() { return (uint)(Environment.TickCount64 & 0xFFFFFFFFL); }

  public static uint InputTick() {
    var l = new LASTINPUTINFO();
    l.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref l)) return 0;
    return l.dwTime;
  }
  public static uint IdleMs() { return (uint)((Tick32() - InputTick()) & 0xFFFFFFFFL); }

  /** 这个键此刻是按下的吗（高位为 1 即按下） */
  public static bool Down(int vk) {
    try { return (GetAsyncKeyState(vk) & 0x8000) != 0; } catch { return false; }
  }

  public static string FgName() {
    try {
      IntPtr h = GetForegroundWindow();
      if (h == IntPtr.Zero) return "";
      string cached;
      if (_cache.TryGetValue(h, out cached)) return cached;
      int pid; GetWindowThreadProcessId(h, out pid);
      string name = "";
      try { name = Process.GetProcessById(pid).ProcessName; } catch { name = ""; }
      if (_cache.Count > 128) _cache.Clear();
      _cache[h] = name;
      return name;
    } catch { return ""; }
  }

  public static string FgTitle() {
    try {
      IntPtr h = GetForegroundWindow();
      var sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      return sb.ToString();
    } catch { return ""; }
  }
}
'@

# ── 热键写法解析："Ctrl+Alt+A" / "Win+Shift+F2" / "Ctrl+F12" ──
$MODS = @{ 'CTRL' = 0x11; 'CONTROL' = 0x11; 'ALT' = 0x12; 'SHIFT' = 0x10; 'WIN' = 0x5B; 'META' = 0x5B }
$KEYS = @{
  'SPACE' = 0x20; 'ENTER' = 0x0D; 'RETURN' = 0x0D; 'ESC' = 0x1B; 'ESCAPE' = 0x1B; 'TAB' = 0x09
  'UP' = 0x26; 'DOWN' = 0x28; 'LEFT' = 0x25; 'RIGHT' = 0x27; 'HOME' = 0x24; 'END' = 0x23
  'PGUP' = 0x21; 'PGDN' = 0x22; 'INS' = 0x2D; 'DEL' = 0x2E; 'BACKSPACE' = 0x08; 'BS' = 0x08
}
foreach ($c in [char[]]'ABCDEFGHIJKLMNOPQRSTUVWXYZ') { $KEYS[[string]$c] = [int]$c }
foreach ($d in 0..9) { $KEYS[[string]$d] = 0x30 + $d }
foreach ($i in 1..24) { $KEYS["F$i"] = 0x6F + $i }

$hotVks = @()
$hotSpec = ''
if ($Hotkey -and $Hotkey.Trim()) {
  $hotSpec = $Hotkey.Trim()
  foreach ($raw in $hotSpec -split '\+') {
    $tok = $raw.Trim().ToUpperInvariant()
    if (-not $tok) { continue }
    if ($MODS.ContainsKey($tok)) { $hotVks += $MODS[$tok] }
    elseif ($KEYS.ContainsKey($tok)) { $hotVks += $KEYS[$tok] }
    else { $hotVks = @(); break }
  }
  if ($hotVks.Count -lt 2) { $hotVks = @() }   # 至少要"修饰键 + 一个键"，免得单纯按个字母就触发
  # 只按 Shift+字母 太容易误触（打大写字母就是 Shift+字母）→ 必须含 Ctrl / Alt / Win
  elseif (-not ($hotVks -contains 0x11) -and -not ($hotVks -contains 0x12) -and -not ($hotVks -contains 0x5B)) {
    "HOTKEY-REJECTED 需要含 Ctrl 或 Alt（Shift+字母 会和打大写字母冲突）"
    $hotVks = @()
  }
}
if ($hotVks.Count) { $hotSpec = $hotSpec } else { $hotSpec = '' }

$prevTick = [uint32]4294967295
$prevFg = '<init>'
$lastBeat = 0
$hotDown = $false
$sleepMs = if ($hotSpec) { 80 } else { 500 }
if ($hotSpec) { "HOTKEY-READY $hotSpec" }

while ($true) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

  # ① 热键（只在上升沿触发一次）
  if ($hotSpec) {
    $all = $true
    foreach ($vk in $hotVks) { if (-not [DshWin4]::Down($vk)) { $all = $false; break } }
    if ($all -and -not $hotDown) {
      [ordered]@{
        ts     = $now
        hotkey = $hotSpec
        fg     = [string][DshWin4]::FgName()
        idleMs = [int][DshWin4]::IdleMs()
      } | ConvertTo-Json -Compress
      $lastBeat = $now
    }
    $hotDown = $all
  }

  # ② 键鼠/前台变化（原 v3 行为）
  $tick = [uint32][DshWin4]::InputTick()
  $fg = [string][DshWin4]::FgName()
  $changed = ($tick -ne $prevTick) -or ($fg -ne $prevFg)
  $beat = (($now - $lastBeat) -gt 10000)
  if ($changed -or $beat) {
    [ordered]@{
      ts        = $now
      idleMs    = [int][DshWin4]::IdleMs()
      fg        = $fg
      title     = [string][DshWin4]::FgTitle()
      inputTick = [int64]$tick
    } | ConvertTo-Json -Compress
    $prevTick = $tick
    $prevFg = $fg
    if ($beat) { $lastBeat = $now }
  }

  Start-Sleep -Milliseconds $sleepMs
}
