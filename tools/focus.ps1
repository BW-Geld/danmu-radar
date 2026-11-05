param(
  [int]$TargetPid = 0,
  [string]$Title = '弹幕雷达',
  [string]$Exclude = 'Microsoft Edge|Google Chrome|Mozilla Firefox| - 个人 - '
)

# 把已经开着的【独立窗口】叫到前台。
# 为什么不用 AppActivate(pid)：Edge 的窗口往往不属于我们 spawn 的那个进程
# （浏览器主进程和窗口所属进程不是同一个），按 pid 找经常直接 MISSED。
# 这里枚举顶层窗口，要求「进程号匹配 + 标题含关键词」，再 SetForegroundWindow。
#
# 必须排除普通浏览器窗口：浏览器里开着同一个页面时，标题是
# 「弹幕雷达 · 斗鱼弹幕统计 和另外 1 个页面 - 个人 - Microsoft Edge」，
# 它同样含「弹幕雷达」。不排除的话，点「打开独立窗口」会把这个标签页窗口
# 当成独立窗口提到前台，然后报告「窗口已经开着」——看起来就是点了没反应。
# 独立窗口的标题只有「弹幕雷达 · 斗鱼弹幕统计」，不含浏览器名。
#
# 白页窗口的标题是 `127.0.0.1_/`，标题对不上 → 返回 MISSED，调用方据此判定「这不是个好窗口」。

$ErrorActionPreference = 'Stop'

$sig = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinFocus {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static IntPtr Find(string needle, uint wantPid, string exclude) {
    IntPtr found = IntPtr.Zero;
    string[] bad = exclude.Split('|');
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (wantPid != 0 && pid != wantPid) return true;
      StringBuilder sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      string t = sb.ToString();
      if (t.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;
      foreach (string s in bad) {
        if (s.Length > 0 && t.IndexOf(s, StringComparison.OrdinalIgnoreCase) >= 0) return true;
      }
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
}
"@

try {
  if (-not ('WinFocus' -as [type])) { Add-Type -TypeDefinition $sig }
  $h = [WinFocus]::Find($Title, [uint32]$TargetPid, $Exclude)
  if ($h -ne [IntPtr]::Zero) {
    [void][WinFocus]::ShowWindow($h, 9)   # SW_RESTORE：最小化过也能拉回来
    [void][WinFocus]::SetForegroundWindow($h)
    'FOCUSED'
  } else {
    'MISSED'
  }
} catch {
  'MISSED'
}