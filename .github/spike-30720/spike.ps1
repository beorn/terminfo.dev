# #30720 spike (@cto verdict 5a737c28). Runs inside a Windows Terminal tab and reads Windows
# Terminal's own text through managed UI Automation, beside the console host's buffer. It settles:
# whether UIA reaches WT here, the visible range (viewport), the Line unit's terminator, what a
# DECDWL/DECDHL row reads as, the host-barrier -> UIA latency, and the U+0001 ownership cell.
# Throwaway: never merged; the branch is deleted after the run.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Probe
)
$ErrorActionPreference = 'Stop'
$logPath = Join-Path $Out 'spike.log'
function Log([string]$m) { Add-Content -LiteralPath $logPath -Value ((Get-Date).ToString('HH:mm:ss.fff') + ' ' + $m) -Encoding UTF8 }

$cs = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;
using System.Windows.Automation.Text;

public static class Spike30720 {
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct CSBI { public COORD Size; public COORD Cursor; public ushort Attributes; public SMALL_RECT Window; public COORD MaxWindow; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleMode(IntPtr handle, out uint mode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleMode(IntPtr handle, uint mode);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool WriteConsoleW(IntPtr handle, string text, uint length, out uint written, IntPtr reserved);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleScreenBufferInfo(IntPtr handle, out CSBI info);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ReadConsoleOutputCharacterW(IntPtr handle, [Out] char[] buffer, uint length, COORD at, out uint read);

  static IntPtr conout = IntPtr.Zero;
  static uint originalMode;

  static Exception Fail(string what) { return new Exception(what + " failed: Win32 error " + Marshal.GetLastWin32Error()); }

  static IntPtr Con() {
    if (conout == IntPtr.Zero) {
      conout = CreateFileW("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (conout == new IntPtr(-1)) throw Fail("CreateFileW(CONOUT$)");
    }
    return conout;
  }

  /// Processed output and VT processing on, as the collector writes; the original mode is restored at the end.
  public static void EnableVt() {
    uint mode;
    if (!GetConsoleMode(Con(), out mode)) throw Fail("GetConsoleMode");
    originalMode = mode;
    if (!SetConsoleMode(Con(), mode | 0x1 | 0x4)) throw Fail("SetConsoleMode(VT)");
  }

  public static void Restore() { SetConsoleMode(Con(), originalMode); }

  /// Returns once the console host has processed the text: WriteConsoleW is synchronous.
  public static void W(string text) {
    uint written;
    if (!WriteConsoleW(Con(), text, (uint)text.Length, out written, IntPtr.Zero)) throw Fail("WriteConsoleW");
  }

  /// Writes with processed output and VT processing cleared, so a C0 control lands in the host buffer as text.
  public static void WRaw(string text) {
    uint mode;
    if (!GetConsoleMode(Con(), out mode)) throw Fail("GetConsoleMode");
    if (!SetConsoleMode(Con(), mode & ~(uint)0x5)) throw Fail("SetConsoleMode(raw)");
    try { W(text); } finally { SetConsoleMode(Con(), mode); }
  }

  public static CSBI Info() {
    CSBI info;
    if (!GetConsoleScreenBufferInfo(Con(), out info)) throw Fail("GetConsoleScreenBufferInfo");
    return info;
  }

  /// The console host's visible window, one string per row.
  public static string[] HostRows() {
    CSBI info = Info();
    int cols = info.Window.Right - info.Window.Left + 1;
    List<string> rows = new List<string>();
    for (int y = info.Window.Top; y <= info.Window.Bottom; y++) {
      char[] buffer = new char[cols];
      uint read;
      COORD at; at.X = info.Window.Left; at.Y = (short)y;
      if (!ReadConsoleOutputCharacterW(Con(), buffer, (uint)cols, at, out read)) throw Fail("ReadConsoleOutputCharacterW");
      rows.Add(new string(buffer, 0, (int)read));
    }
    return rows.ToArray();
  }

  static AutomationElementCollection Tops(int pid) {
    return AutomationElement.RootElement.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ProcessIdProperty, pid));
  }

  public static AutomationElement[] TermControls(int pid) {
    List<AutomationElement> found = new List<AutomationElement>();
    foreach (AutomationElement top in Tops(pid)) {
      foreach (AutomationElement term in top.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ClassNameProperty, "TermControl"))) found.Add(term);
    }
    return found.ToArray();
  }

  /// When no TermControl is found: the class names WT does expose, so one run says where the text lives.
  public static string DescendantClasses(int pid) {
    StringBuilder text = new StringBuilder();
    int count = 0;
    foreach (AutomationElement top in Tops(pid)) {
      foreach (AutomationElement element in top.FindAll(TreeScope.Descendants, Condition.TrueCondition)) {
        if (count++ >= 80) return text.ToString();
        text.Append(element.Current.ClassName).Append('/').Append(element.Current.ControlType.ProgrammaticName).Append("; ");
      }
    }
    return text.ToString();
  }

  public static string TopStates(int pid) {
    StringBuilder text = new StringBuilder();
    foreach (AutomationElement top in Tops(pid)) {
      object pattern;
      string state = "no WindowPattern";
      if (top.TryGetCurrentPattern(WindowPattern.Pattern, out pattern)) state = ((WindowPattern)pattern).Current.WindowVisualState.ToString();
      text.Append(top.Current.ClassName).Append(" '").Append(top.Current.Name).Append("' ").Append(state).Append(" offscreen=").Append(top.Current.IsOffscreen).Append("; ");
    }
    return text.ToString();
  }

  public static string Describe(AutomationElement term) {
    StringBuilder text = new StringBuilder();
    text.Append("class=").Append(term.Current.ClassName).Append(" type=").Append(term.Current.ControlType.ProgrammaticName)
      .Append(" name='").Append(term.Current.Name).Append("' offscreen=").Append(term.Current.IsOffscreen)
      .Append(" rect=").Append(term.Current.BoundingRectangle.ToString()).Append(" patterns=");
    foreach (AutomationPattern pattern in term.GetSupportedPatterns()) text.Append(pattern.ProgrammaticName).Append(',');
    return text.ToString();
  }

  public static int VisibleRangeCount(AutomationElement term) {
    return ((TextPattern)term.GetCurrentPattern(TextPattern.Pattern)).GetVisibleRanges().Length;
  }

  /// The visible text, one Line unit per entry; `whole` receives each visible range's full text.
  public static string[] UiaRows(AutomationElement term, List<string> whole) {
    TextPattern pattern = (TextPattern)term.GetCurrentPattern(TextPattern.Pattern);
    List<string> rows = new List<string>();
    foreach (TextPatternRange visible in pattern.GetVisibleRanges()) {
      if (whole != null) whole.Add(visible.GetText(-1));
      TextPatternRange cursor = visible.Clone();
      cursor.MoveEndpointByRange(TextPatternRangeEndpoint.End, cursor, TextPatternRangeEndpoint.Start);
      for (int i = 0; i < 1000; i++) {
        TextPatternRange line = cursor.Clone();
        line.ExpandToEnclosingUnit(TextUnit.Line);
        if (line.CompareEndpoints(TextPatternRangeEndpoint.Start, visible, TextPatternRangeEndpoint.End) >= 0) break;
        rows.Add(line.GetText(-1));
        if (cursor.Move(TextUnit.Line, 1) == 0) break;
      }
    }
    return rows.ToArray();
  }

  public static string Esc(string text) {
    StringBuilder escaped = new StringBuilder();
    foreach (char ch in text) {
      if (ch < 0x20 || ch > 0x7E) escaped.Append("\\u").Append(((int)ch).ToString("X4"));
      else if (ch == '\\') escaped.Append("\\\\");
      else escaped.Append(ch);
    }
    return escaped.ToString();
  }

  /// Per trial: clear, write a fresh marker (the host has processed it when W returns), then read UIA
  /// back-to-back until the marker appears. Returns elapsed ms per trial, -1 when never seen.
  public static double[] Latency(AutomationElement term, int trials, int timeoutMs, List<string> notes) {
    Random random = new Random();
    List<double> elapsed = new List<double>();
    for (int trial = 0; trial < trials; trial++) {
      W("\u001b[2J\u001b[H");
      System.Threading.Thread.Sleep(200);
      string marker = "LAT-" + trial + "-" + random.Next(100000, 999999);
      W("\u001b[5;3H" + marker);
      Stopwatch watch = Stopwatch.StartNew();
      int reads = 0;
      bool seen = false;
      while (!seen && watch.ElapsedMilliseconds < timeoutMs) {
        reads++;
        foreach (string row in UiaRows(term, null)) { if (row.Contains(marker)) { seen = true; break; } }
      }
      double ms = watch.Elapsed.TotalMilliseconds;
      elapsed.Add(seen ? ms : -1);
      notes.Add("trial " + trial + " seen=" + seen + " ms=" + ms.ToString("F1") + " reads=" + reads);
    }
    return elapsed.ToArray();
  }
}
'@

$results = [ordered]@{}
$exitCode = 1
$E = [string][char]27
function Csi([string]$s) { return $E + '[' + $s }
function Esc($rows) { return @($rows | ForEach-Object { [Spike30720]::Esc([string]$_) }) }
function Shot([string]$name, $term) {
  try {
    $r = $term.Current.BoundingRectangle
    $bmp = New-Object System.Drawing.Bitmap ([int]$r.Width), ([int]$r.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen([int]$r.Left, [int]$r.Top, 0, 0, $bmp.Size)
    $bmp.Save((Join-Path $Out ($name + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    return 'saved ' + $name + '.png'
  } catch { return 'screenshot failed: ' + $_.Exception.Message }
}
function Experiment([string]$name, [scriptblock]$body) {
  Log ('begin ' + $name)
  try { $results[$name] = & $body }
  catch { $results[$name] = [ordered]@{ error = $_.Exception.ToString() }; Log ('error ' + $name + ': ' + $_.Exception.Message) }
  Log ('end ' + $name)
}
function Settle { Start-Sleep -Milliseconds 1500 }
function Stats([double[]]$values) {
  $seen = @($values | Where-Object { $_ -ge 0 } | Sort-Object)
  if ($seen.Count -eq 0) { return [ordered]@{ seen = 0; unseen = $values.Count } }
  return [ordered]@{
    seen = $seen.Count; unseen = $values.Count - $seen.Count
    min = $seen[0]; median = $seen[[int][math]::Floor(($seen.Count - 1) / 2)]
    p95 = $seen[[int][math]::Ceiling(0.95 * $seen.Count) - 1]; max = $seen[$seen.Count - 1]
  }
}

try {
  Log ('start; PowerShell ' + $PSVersionTable.PSVersion + '; session ' + (Get-Process -Id $PID).SessionId + '; interactive ' + [Environment]::UserInteractive)
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Drawing
  $refs = @(
    [System.Windows.Automation.AutomationElement].Assembly.Location,
    [System.Windows.Automation.Text.TextUnit].Assembly.Location,
    [System.Windows.Rect].Assembly.Location
  )
  Add-Type -ReferencedAssemblies $refs -TypeDefinition $cs
  [Spike30720]::EnableVt()

  $chain = @()
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
  for ($i = 0; $i -lt 8 -and $null -ne $p; $i++) {
    $chain += [ordered]@{ pid = $p.ProcessId; name = $p.Name; path = $p.ExecutablePath }
    $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p.ParentProcessId)
  }
  $wt = $chain | Where-Object { $_.name -eq 'WindowsTerminal.exe' } | Select-Object -First 1
  if ($null -eq $wt) { throw 'no WindowsTerminal.exe ancestor' }
  $wtPid = [int]$wt.pid
  $terms = [Spike30720]::TermControls($wtPid)
  if ($terms.Count -eq 0) {
    $results['noTermControl'] = [ordered]@{ topWindows = [Spike30720]::TopStates($wtPid); descendants = [Spike30720]::DescendantClasses($wtPid) }
    throw ('no TermControl under WindowsTerminal.exe pid ' + $wtPid)
  }
  $term = $terms[0]
  $info = [Spike30720]::Info()

  Experiment 'context' {
    $costs = @()
    for ($i = 0; $i -lt 10; $i++) {
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      [void][Spike30720]::UiaRows($term, $null)
      $costs += $sw.Elapsed.TotalMilliseconds
    }
    [ordered]@{
      chain = $chain
      consoleHosts = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('OpenConsole.exe', 'conhost.exe') } | ForEach-Object { [ordered]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; path = $_.ExecutablePath } })
      wtPid = $wtPid
      termControlCount = $terms.Count
      termControl = [Spike30720]::Describe($term)
      topWindows = [Spike30720]::TopStates($wtPid)
      visibleRanges = [Spike30720]::VisibleRangeCount($term)
      hostWindow = ('cols ' + ($info.Window.Right - $info.Window.Left + 1) + ' rows ' + ($info.Window.Bottom - $info.Window.Top + 1) + ' top ' + $info.Window.Top + ' buffer ' + $info.Size.X + 'x' + $info.Size.Y)
      uiaReadMs = Stats $costs
    }
  }

  Experiment 'u0001' {
    [Spike30720]::W((Csi '2J') + (Csi 'H') + (Csi '2;1H') + 'U1:[')
    [Spike30720]::WRaw([string][char]1)
    [Spike30720]::W(']' + (Csi '4;1H') + 'VT:[' + [char]1 + ']' + (Csi '6;1H') + 'END')
    Settle
    $hostRows = [Spike30720]::HostRows()
    $whole = New-Object 'System.Collections.Generic.List[string]'
    $uiaRows = [Spike30720]::UiaRows($term, $whole)
    $hostRow = @($hostRows | Where-Object { $_.Contains('U1:[') })[0]
    $uiaRow = @($uiaRows | Where-Object { $_.Contains('U1:[') })[0]
    $hostCell = if ($null -ne $hostRow) { $hostRow.Substring($hostRow.IndexOf('U1:[') + 4, 1) } else { $null }
    $uiaCell = if ($null -ne $uiaRow) { $start = $uiaRow.IndexOf('U1:[') + 4; $uiaRow.Substring($start, $uiaRow.IndexOf(']', $start) - $start) } else { $null }
    [ordered]@{
      hostCell = if ($null -ne $hostCell) { [Spike30720]::Esc($hostCell) } else { 'row not found' }
      observerCell = if ($null -ne $uiaCell) { [Spike30720]::Esc($uiaCell) } else { 'row not found' }
      discriminates = ($hostCell -eq [string][char]1) -and ($null -ne $uiaCell) -and ($uiaCell -ne [string][char]1)
      hostRows = Esc ($hostRows | Select-Object -First 7)
      uiaRows = Esc ($uiaRows | Select-Object -First 7)
      screenshot = Shot 'u0001' $term
    }
  }

  Experiment 'latency' {
    $notes = New-Object 'System.Collections.Generic.List[string]'
    $ms = [Spike30720]::Latency($term, 40, 5000, $notes)
    [ordered]@{ hostBarrierToUiaMs = Stats $ms; trials = @($notes) }
  }

  Experiment 'viewport' {
    [Spike30720]::W((Csi '2J') + (Csi 'H'))
    for ($i = 1; $i -le 150; $i++) { [Spike30720]::W(('SCROLL-{0:D3}' -f $i) + "`r`n") }
    [Spike30720]::W('TAIL')
    Settle
    $now = [Spike30720]::Info()
    $whole = New-Object 'System.Collections.Generic.List[string]'
    $uiaRows = [Spike30720]::UiaRows($term, $whole)
    $hostRows = [Spike30720]::HostRows()
    [ordered]@{
      visibleRanges = $whole.Count
      uiaRowCount = $uiaRows.Count
      uiaFirst = Esc ($uiaRows | Select-Object -First 3)
      uiaLast = Esc ($uiaRows | Select-Object -Last 3)
      hostWindowTop = $now.Window.Top; hostCursorY = $now.Cursor.Y
      hostFirst = Esc ($hostRows | Select-Object -First 3)
      hostLast = Esc ($hostRows | Select-Object -Last 3)
      wholeHead = [Spike30720]::Esc(([string]$whole[0]).Substring(0, [math]::Min(400, ([string]$whole[0]).Length)))
    }
  }

  Experiment 'wrap' {
    $cols = $info.Window.Right - $info.Window.Left + 1
    [Spike30720]::W((Csi '2J') + (Csi 'H') + ('W' * ($cols + 10)) + "`r`n" + 'NEXT')
    Settle
    $whole = New-Object 'System.Collections.Generic.List[string]'
    $uiaRows = [Spike30720]::UiaRows($term, $whole)
    [ordered]@{
      cols = $cols
      uiaRows = Esc ($uiaRows | Select-Object -First 4)
      wholeHead = [Spike30720]::Esc(([string]$whole[0]).Substring(0, [math]::Min(400, ([string]$whole[0]).Length)))
    }
  }

  Experiment 'doubleWidth' {
    [Spike30720]::W((Csi '2J') + (Csi 'H') + (Csi '2;1H') + $E + '#6' + 'DWL-ROW' + (Csi '4;1H') + $E + '#3' + 'DHL-ROW' + (Csi '5;1H') + $E + '#4' + 'DHL-ROW' + (Csi '7;1H') + 'NORMAL-ROW')
    Settle
    [ordered]@{
      uiaRows = Esc ([Spike30720]::UiaRows($term, $null) | Select-Object -First 8)
      hostRows = Esc ([Spike30720]::HostRows() | Select-Object -First 8)
      screenshot = Shot 'double-width' $term
    }
  }

  Experiment 'wide' {
    $family = [char]::ConvertFromUtf32(0x1F468) + [char]0x200D + [char]::ConvertFromUtf32(0x1F469) + [char]0x200D + [char]::ConvertFromUtf32(0x1F467)
    $flag = [char]::ConvertFromUtf32(0x1F1EF) + [char]::ConvertFromUtf32(0x1F1F5)
    [Spike30720]::W((Csi '2J') + (Csi 'H') + (Csi '2;1H') + 'A' + [char]0x754C + 'B|e' + [char]0x0301 + '|' + $family + '|' + $flag + '|END')
    Settle
    [ordered]@{
      uiaRows = Esc ([Spike30720]::UiaRows($term, $null) | Select-Object -First 3)
      hostRows = Esc ([Spike30720]::HostRows() | Select-Object -First 3)
    }
  }

  Experiment 'readerProcess' {
    $runs = @()
    for ($i = 0; $i -lt 3; $i++) {
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $printed = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Probe -WtPid $wtPid
      $runs += [ordered]@{ ms = $sw.Elapsed.TotalMilliseconds; printed = [string]$printed }
    }
    [ordered]@{ runs = $runs }
  }

  $exitCode = 0
} catch {
  Log ('FAILED: ' + $_.Exception.ToString())
  $results['fatal'] = $_.Exception.ToString()
} finally {
  try { [Spike30720]::Restore() } catch { }
  $results | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Out 'results.json') -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $Out 'spike-exit') -Value $exitCode -Encoding ascii
  Log ('exit ' + $exitCode)
}
exit $exitCode
