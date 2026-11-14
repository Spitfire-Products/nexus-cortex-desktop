# nexus-guest-uia.ps1 - the IN-GUEST perception helper for the `desktop` tool (@nexus-cortex/browser 0.5).
# Runs INSIDE a Windows guest (Parallels/VMware/VirtualBox) where the host's accessibility API cannot see the guest's controls.
# It answers requests through a SHARED FOLDER (no network, no listener): the host writes req-<id>.json, this script writes resp-<id>.json.
# Windows 7+ built-ins only: PowerShell 2.0, .NET 3.5 UIAutomationClient + System.Web.Extensions (JavaScriptSerializer). Nothing to install.
# SAFETY: it performs UI Automation reads and the Invoke/Toggle/Select/ExpandCollapse/SetValue patterns - nothing else. No shell, no
# process launch, no file access outside the bridge folder. Stop it with Ctrl+C (or close its window).
#
# Start (inside the VM):  Win+R ->  powershell -ExecutionPolicy Bypass -NoExit -File "\\psf\Home\nexus-guest-bridge\nexus-guest-uia.ps1"
# This file MUST stay ASCII-only: PowerShell 2.0 reads a BOM-less script as ANSI (0.5.0 broke on a UTF-8 dash).
param(
  [string]$Bridge = '\\psf\Home\nexus-guest-bridge',   # Parallels Desktop shared Home (\\Mac\Home on some setups)
  [int]$PollMs = 150,
  [int]$MaxNodes = 600
)
$VERSION = '0.11.5'
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Web.Extensions
# 0.5.3: real top-level windows via Win32 EnumWindows (the native Save As dialog, #32770, is a top-level OWNED window that the UIA root
# children list missed) + SetForegroundWindow/ShowWindow for focusing windows (console windows throw on UIA SetFocus). C# 2.0 syntax only.
if (-not ('NexusGuestWin32' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class NexusGuestWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  public static string Title(IntPtr h) { StringBuilder sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static string Cls(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static IntPtr[] VisibleTitled() {
    List<IntPtr> found = new List<IntPtr>();
    EnumWindows(delegate (IntPtr h, IntPtr l) { if (IsWindowVisible(h) && Title(h).Length > 0) found.Add(h); return true; }, IntPtr.Zero);
    return found.ToArray();
  }
}
'@
}
# 0.6: foreground window + owning process for the "state" op (desktop context / watch). A SEPARATE type so a console that already loaded
# NexusGuestWin32 from an older helper still compiles this one.
if (-not ('NexusGuestFg' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NexusGuestFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
}
'@
}
$json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$json.MaxJsonLength = 20971520
$AE = [System.Windows.Automation.AutomationElement]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
if (-not (Test-Path -LiteralPath $Bridge)) { New-Item -ItemType Directory -Path $Bridge | Out-Null }
Write-Host ("nexus-guest-uia {0} watching {1} (Ctrl+C to stop)" -f $VERSION, $Bridge)

# JSON OUTPUT is emitted by hand: only strings / numbers / bools / null / arrays / dictionaries, PSObject wrappers unwrapped first.
# (JavaScriptSerializer is used for INPUT only.) Non-ASCII is \u-escaped so the response file is plain ASCII.
function JStr([string]$s) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  foreach ($ch in $s.ToCharArray()) {
    $c = [int]$ch
    if ($c -eq 34) { [void]$sb.Append('\"') }
    elseif ($c -eq 92) { [void]$sb.Append('\\') }
    elseif ($c -eq 10) { [void]$sb.Append('\n') }
    elseif ($c -eq 13) { [void]$sb.Append('\r') }
    elseif ($c -eq 9) { [void]$sb.Append('\t') }
    elseif ($c -lt 32 -or $c -gt 126) { [void]$sb.Append(('\u{0:x4}' -f $c)) }
    else { [void]$sb.Append($ch) }
  }
  [void]$sb.Append('"')
  return $sb.ToString()
}
function ToJson($o) {
  if ($null -eq $o) { return 'null' }
  if ($o -is [System.Management.Automation.PSObject]) { $o = $o.PSObject.BaseObject }
  if ($o -is [bool]) { if ($o) { return 'true' } else { return 'false' } }
  if ($o -is [int] -or $o -is [long] -or $o -is [int16] -or $o -is [byte] -or $o -is [uint32] -or $o -is [uint64]) { return ([long]$o).ToString([Globalization.CultureInfo]::InvariantCulture) }
  if ($o -is [double] -or $o -is [single] -or $o -is [decimal]) { $d = [double]$o; if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return '0' }; return $d.ToString('R', [Globalization.CultureInfo]::InvariantCulture) }
  if ($o -is [string] -or $o -is [char]) { return (JStr ([string]$o)) }
  if ($o -is [System.Collections.IDictionary]) {
    $parts = New-Object System.Collections.ArrayList
    foreach ($k in @($o.Keys)) { [void]$parts.Add((JStr ([string]$k)) + ':' + (ToJson $o[$k])) }
    return '{' + [string]::Join(',', $parts.ToArray()) + '}'
  }
  if ($o -is [System.Collections.IEnumerable]) {
    $parts = New-Object System.Collections.ArrayList
    foreach ($x in $o) { [void]$parts.Add((ToJson $x)) }
    return '[' + [string]::Join(',', $parts.ToArray()) + ']'
  }
  return (JStr ([string]$o))
}

function Num([double]$d) { if ([double]::IsInfinity($d) -or [double]::IsNaN($d)) { return 0 } return [int][Math]::Round($d) }

function Win-Info($w) {
  $c = $w.Current; $r = $c.BoundingRectangle
  return @{ name = [string]$c.Name; cls = [string]$c.ClassName; pid = [int]$c.ProcessId; x = (Num $r.X); y = (Num $r.Y); w = (Num $r.Width); h = (Num $r.Height) }
}

function Top-Windows {
  # root children PLUS each root window's own Window-type children (owned dialogs / wizards are not root children - 0.5.1 report)
  $root = $AE::RootElement
  $list = New-Object System.Collections.ArrayList
  $isWin = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  foreach ($w in @($root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition))) {
    if ($w -eq $null) { continue }
    [void]$list.Add($w)
    try { foreach ($c in @($w.FindAll([System.Windows.Automation.TreeScope]::Children, $isWin))) { if ($c -ne $null) { [void]$list.Add($c) } } } catch { }
  }
  # 0.5.3: plus every visible titled top-level HWND (Z-order) - owned dialogs such as Save As (#32770); dedupe by NativeWindowHandle
  $seen = @{}
  foreach ($w in @($list.ToArray())) { if ($w -eq $null) { continue }; try { $seen[[long]$w.Current.NativeWindowHandle] = $true } catch { } }
  $hwnds = @()
  try { $hwnds = @([NexusGuestWin32]::VisibleTitled()) } catch { }
  foreach ($h in $hwnds) {
    if ($h -eq $null) { continue }
    $k = $h.ToInt64()
    if ($seen.ContainsKey($k)) { continue }
    $seen[$k] = $true
    try { $e = $AE::FromHandle($h); if ($e -ne $null) { [void]$list.Add($e) } } catch { }
  }
  return $list.ToArray()
}

function Find-Window([string]$title) {
  if (-not $title) {
    $fg = $null
    try { $fg = $AE::FocusedElement } catch { }
    while ($fg -ne $null) {   # climb from the focused element to its top-level window
      $parent = $walker.GetParent($fg)
      if ($parent -eq $null -or $parent -eq $AE::RootElement) { return $fg }
      $fg = $parent
    }
    throw 'no focused window - pass window:"part of the title"'
  }
  foreach ($w in @(Top-Windows)) { if ($w -eq $null) { continue }; try { if (([string]$w.Current.Name).ToLower().Contains($title.ToLower())) { return $w } } catch { } }
  throw ("no top-level window whose title contains '{0}' - try guest_windows" -f $title)
}

function El-Info($e, $path) {
  $c = $e.Current; $r = $c.BoundingRectangle
  $val = ''
  try { $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $val = [string]$vp.Current.Value } catch { }
  $role = ([string]$c.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
  return @{ p = $path; r = $role; t = [string]$c.Name; aid = [string]$c.AutomationId; cls = [string]$c.ClassName; v = $val;
            x = (Num $r.X); y = (Num $r.Y); w = (Num $r.Width); h = (Num $r.Height); e = [bool]$c.IsEnabled; f = [bool]$c.HasKeyboardFocus;
            off = [bool]$c.IsOffscreen }
}

function Walk($e, $path, [int]$d, $out, [int]$max, [int]$depth) {
  $child = $walker.GetFirstChild($e); $i = 0
  while ($child -ne $null) {
    if ($out.Count -ge $max) { $script:truncated = $true; return }
    $p = @($path) + @($i)
    $info = $null
    try { $info = El-Info $child $p } catch { }   # an element can vanish mid-walk (dialog repaint) - skip it, keep scanning
    if ($info -ne $null) {
      if ($info.v.Length -gt 160) { $info.v = $info.v.Substring(0, 160) }
      [void]$out.Add($info)
      if ($d -lt $depth) { try { Walk $child $p ($d + 1) $out $max $depth } catch { } }
    }
    $child = $walker.GetNextSibling($child); $i++
  }
}

function Resolve($win, $path) {
  $e = $win
  foreach ($idx in $path) {
    $c = $walker.GetFirstChild($e)
    for ($k = 0; $k -lt [int]$idx; $k++) { if ($c -eq $null) { break }; $c = $walker.GetNextSibling($c) }
    if ($c -eq $null) { throw 'element path no longer valid (the window changed) - guest_scan again' }
    $e = $c
  }
  return $e
}

function Do-Press($e) {
  try { $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return 'Invoke' } catch { }
  try { $e.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle(); return 'Toggle' } catch { }
  try { $e.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); return 'SelectionItem' } catch { }
  try {
    $x = $e.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    if ([string]$x.Current.ExpandCollapseState -eq 'Collapsed') { $x.Expand() } else { $x.Collapse() }
    return 'ExpandCollapse'
  } catch { }
  throw 'element supports no Invoke / Toggle / SelectionItem / ExpandCollapse pattern - click it instead'
}

function Do-Set($e, [string]$v) {
  $vp = $null
  try { $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch { throw 'element has no Value pattern (not an editable text/value control) - type into it instead' }
  if ($vp.Current.IsReadOnly) { throw 'value is read-only via UI Automation (e.g. some Win32 date pickers) - type into it instead' }
  try { $e.SetFocus() } catch { }
  $vp.SetValue($v)
  return [string]$vp.Current.Value
}

function Do-Focus($w) {
  $name = ''; try { $name = [string]$w.Current.Name } catch { }
  try { $w.SetFocus(); return @{ window = $name; how = 'UIA' } } catch { }
  # 0.5.3: console windows (and some legacy ones) throw on UIA SetFocus -> Win32: restore if minimized, then SetForegroundWindow
  $h = [IntPtr]::Zero
  try { $h = New-Object IntPtr ([long]$w.Current.NativeWindowHandle) } catch { }
  if ($h -eq [IntPtr]::Zero) { throw 'UIA SetFocus failed and the window has no native handle' }
  if ([NexusGuestWin32]::IsIconic($h)) { [void][NexusGuestWin32]::ShowWindow($h, 9) }   # SW_RESTORE
  $okFg = [NexusGuestWin32]::SetForegroundWindow($h)
  return @{ window = $name; how = 'SetForegroundWindow'; fg = [bool]$okFg }
}

$procNames = @{}
function Proc-Name($h) {
  $p = [NexusGuestFg]::Pid($h)
  if ($procNames.ContainsKey($p)) { return $procNames[$p] }
  $n = '?'; try { $n = [Diagnostics.Process]::GetProcessById([int]$p).ProcessName } catch { }
  $procNames[$p] = $n; return $n
}
function Str-Hash([string]$s) {
  # a change detector only (the host never sees the text): djb2-xor kept inside 31 bits
  [long]$h = 5381
  foreach ($ch in $s.ToCharArray()) { $h = ((($h * 33) -bxor [long][int]$ch) % 2147483647) }
  return $h
}
function Get-State {
  $fg = [IntPtr]::Zero
  try { $fg = [NexusGuestFg]::GetForegroundWindow() } catch { }
  $fgi = @{ id = $fg.ToInt64(); title = ''; cls = ''; proc = '' }
  if ($fg -ne [IntPtr]::Zero) {
    $fgi.title = [NexusGuestWin32]::Title($fg); $fgi.cls = [NexusGuestWin32]::Cls($fg)
    try { $fgi.proc = Proc-Name $fg } catch { }
  }
  $foc = $null
  try {
    $fe = $AE::FocusedElement
    if ($fe -ne $null) {
      $c = $fe.Current; $v = $null
      try { $vp = $fe.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $v = [string]$vp.Current.Value } catch { }
      $isPw = $false; try { $isPw = [bool]$c.IsPassword } catch { }
      $n = $null; $hv = 0
      if ($v -ne $null -and -not $isPw) { $n = $v.Length; $hv = Str-Hash $v }
      $role = ([string]$c.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
      $foc = @{ r = $role; t = [string]$c.Name; cls = [string]$c.ClassName; n = $n; h = $hv }
    }
  } catch { }
  $wins = New-Object System.Collections.ArrayList
  $hw = @()
  try { $hw = @([NexusGuestWin32]::VisibleTitled()) } catch { }
  foreach ($h in $hw) {
    if ($h -eq $null) { continue }
    $pn = ''; try { $pn = Proc-Name $h } catch { }
    [void]$wins.Add(@{ id = $h.ToInt64(); title = [NexusGuestWin32]::Title($h); cls = [NexusGuestWin32]::Cls($h); proc = $pn })
  }
  return @{ fg = $fgi; focus = $foc; windows = $wins.ToArray() }
}

function Handle($req) {
  $op = [string]$req['op']
  switch ($op) {
    'ping'    { return @{ version = $VERSION; user = [Environment]::UserName; os = [Environment]::OSVersion.VersionString; ps = $PSVersionTable.PSVersion.ToString() } }
    'windows' { $list = New-Object System.Collections.ArrayList; foreach ($w in @(Top-Windows)) { if ($w -eq $null) { continue }; try { $wi = Win-Info $w; if ($wi.name) { [void]$list.Add($wi) } } catch { } }; return @{ windows = $list.ToArray() } }
    'scan'    {
      $w = Find-Window ([string]$req['window'])
      $max = $MaxNodes; if ($req['max']) { $max = [int]$req['max'] }
      $depth = 12; if ($req['depth']) { $depth = [int]$req['depth'] }
      $out = New-Object System.Collections.ArrayList; $script:truncated = $false
      $t0 = Get-Date
      Walk $w @() 1 $out $max $depth
      return @{ window = [string]$w.Current.Name; els = $out.ToArray(); truncated = $script:truncated; ms = [int]((Get-Date) - $t0).TotalMilliseconds }
    }
    'get'     { $w = Find-Window ([string]$req['window']); $e = Resolve $w $req['path']; $i = El-Info $e $req['path']; $kids = 0; $c = $walker.GetFirstChild($e); while ($c -ne $null) { $kids++; $c = $walker.GetNextSibling($c) }; $i.n = $kids; return $i }
    'press'   { $w = Find-Window ([string]$req['window']); $e = Resolve $w $req['path']; $how = Do-Press $e; return @{ how = $how } }
    'set'     { $w = Find-Window ([string]$req['window']); $e = Resolve $w $req['path']; $now = Do-Set $e ([string]$req['value']); return @{ v = $now } }
    'focus'   { $w = Find-Window ([string]$req['window']); return (Do-Focus $w) }
    'state'   { return (Get-State) }
    default   { throw ("unknown op '{0}' (ping windows scan get press set focus state)" -f $op) }
  }
}

$lastBeat = [DateTime]::MinValue
while ($true) {
  if (((Get-Date) - $lastBeat).TotalSeconds -ge 3) { try {
    $beat = @{ version = $VERSION; ts = [DateTime]::UtcNow.ToString('o'); pid = $PID }
    $tmpB = Join-Path $Bridge 'helper-alive.tmp'
    [IO.File]::WriteAllText($tmpB, (ToJson $beat))
    Move-Item -Force -LiteralPath $tmpB -Destination (Join-Path $Bridge 'helper-alive.json')
    } catch { Write-Host ('heartbeat write failed: ' + $_.Exception.Message) }
    $lastBeat = Get-Date
  }
  # PowerShell 2.0: foreach over $null runs ONCE - always wrap in @() and skip nulls
  foreach ($f in @(Get-ChildItem -LiteralPath $Bridge -Filter 'req-*.json' | Sort-Object Name)) {
    if ($f -eq $null) { continue }
    $id = $f.BaseName.Substring(4)
    $res = $null
    try {
      $raw = [IO.File]::ReadAllText($f.FullName)
      Remove-Item -LiteralPath $f.FullName
      if ($raw.Length -gt 65536) { throw 'request too large' }
      $req = $json.DeserializeObject($raw)
      $res = Handle $req
      $res['ok'] = $true
    } catch {
      $res = @{ ok = $false; error = [string]$_.Exception.Message }
    }
    $res['id'] = $id
    $body = $null
    try { $body = ToJson $res } catch { $body = '{"ok":false,"id":' + (JStr $id) + ',"error":' + (JStr ('could not encode the response: ' + $_.Exception.Message)) + '}' }
    try {
      $tmp = Join-Path $Bridge ('resp-' + $id + '.tmp')
      [IO.File]::WriteAllText($tmp, $body)
      Move-Item -Force -LiteralPath $tmp -Destination (Join-Path $Bridge ('resp-' + $id + '.json'))
    } catch { Write-Host ('could not write response ' + $id + ': ' + $_.Exception.Message) }
  }
  Start-Sleep -Milliseconds $PollMs
}
