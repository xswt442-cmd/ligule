param(
  [Parameter(Mandatory = $true)][int]$RootProcessId,
  [int]$WidthDelta = 80,
  [int]$HeightDelta = 50
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class LiguleWindowBounds {
  [StructLayout(LayoutKind.Sequential)]
  private struct Rect {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] private static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
  [DllImport("user32.dll")] private static extern int GetClassName(IntPtr window, StringBuilder text, int capacity);
  [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);

  public static long[] TopLevelWindowHandles(int[] processIds) {
    var owners = new HashSet<int>(processIds);
    var handles = new List<long>();
    EnumWindowsProc callback = delegate(IntPtr window, IntPtr parameter) {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      if (owners.Count == 0 || owners.Contains((int)owner)) handles.Add(window.ToInt64());
      return true;
    };
    EnumWindows(callback, IntPtr.Zero);
    GC.KeepAlive(callback);
    return handles.ToArray();
  }

  public static bool IsVisible(long handle) {
    return IsWindowVisible(new IntPtr(handle));
  }

  public static int OwnerProcessId(long handle) {
    uint owner;
    GetWindowThreadProcessId(new IntPtr(handle), out owner);
    return (int)owner;
  }

  public static string Title(long handle) {
    var text = new StringBuilder(512);
    GetWindowText(new IntPtr(handle), text, text.Capacity);
    return text.ToString();
  }

  public static string ClassName(long handle) {
    var text = new StringBuilder(256);
    GetClassName(new IntPtr(handle), text, text.Capacity);
    return text.ToString();
  }

  public static int[] Bounds(long handle) {
    Rect rect;
    if (!GetWindowRect(new IntPtr(handle), out rect)) throw new InvalidOperationException("get_window_rect_failed");
    return new[] { rect.Left, rect.Top, rect.Right, rect.Bottom };
  }

  public static bool Resize(long handle, int x, int y, int width, int height) {
    return SetWindowPos(new IntPtr(handle), IntPtr.Zero, x, y, width, height, 0x0014);
  }

  public static void ShowWithoutActivation(long handle) {
    ShowWindow(new IntPtr(handle), 4);
  }

  public static void Hide(long handle) {
    ShowWindow(new IntPtr(handle), 0);
  }
}
'@

$processes = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath)
$allowedProcessIds = [System.Collections.Generic.HashSet[int]]::new()
[void]$allowedProcessIds.Add($RootProcessId)
do {
  $addedProcess = $false
  foreach ($process in $processes) {
    if ($allowedProcessIds.Contains([int]$process.ParentProcessId) -and $allowedProcessIds.Add([int]$process.ProcessId)) {
      $addedProcess = $true
    }
  }
} while ($addedProcess)

$allowedIds = [int[]]@($allowedProcessIds | ForEach-Object { $_ })
$handles = @( [LiguleWindowBounds]::TopLevelWindowHandles($allowedIds) )
$matchedWindows = @($handles | Where-Object {
  [LiguleWindowBounds]::ClassName($_) -eq 'Chrome_WidgetWin_1' -and [LiguleWindowBounds]::Title($_) -eq 'ligule'
})
if ($matchedWindows.Count -ne 1) {
  $candidates = @($handles | ForEach-Object {
    "pid=$([LiguleWindowBounds]::OwnerProcessId($_));class=$([LiguleWindowBounds]::ClassName($_));title=$([LiguleWindowBounds]::Title($_));visible=$([LiguleWindowBounds]::IsVisible($_))"
  }) -join '|'
  $allHandles = @( [LiguleWindowBounds]::TopLevelWindowHandles([int[]]@()) )
  $appWindows = @($allHandles | ForEach-Object {
    $owner = [LiguleWindowBounds]::OwnerProcessId($_)
    $process = $processes | Where-Object { [int]$_.ProcessId -eq $owner -and $_.Name -eq 'ligule.exe' } | Select-Object -First 1
    if ($null -ne $process) { "pid=$owner;path=$($process.ExecutablePath);class=$([LiguleWindowBounds]::ClassName($_))" }
  }) -join '|'
  throw "expected_one_ligule_browser_window_for_isolated_process_tree;matches=$($matchedWindows.Count);ownerTreePids=$($allowedIds -join ',');candidates=$candidates;liguleProcessWindows=$appWindows"
}

$handle = [long]$matchedWindows[0]
$before = [LiguleWindowBounds]::Bounds($handle)
$beforeWidth = $before[2] - $before[0]
$beforeHeight = $before[3] - $before[1]
if ($beforeWidth -lt 200 -or $beforeHeight -lt 200) { throw 'window_bounds_before_resize_invalid' }

$wasVisible = [LiguleWindowBounds]::IsVisible($handle)
$madeVisible = $false
$resized = $false
$afterResize = $null
try {
  if (-not $wasVisible) {
    [LiguleWindowBounds]::ShowWithoutActivation($handle)
    $madeVisible = $true
    Start-Sleep -Milliseconds 150
    if (-not [LiguleWindowBounds]::IsVisible($handle)) { throw 'window_show_without_activation_failed' }
  }
  $resized = [LiguleWindowBounds]::Resize($handle, $before[0], $before[1], $beforeWidth + $WidthDelta, $beforeHeight + $HeightDelta)
  if (-not $resized) { throw 'set_window_pos_resize_failed' }
  Start-Sleep -Milliseconds 500
  $afterResize = [LiguleWindowBounds]::Bounds($handle)
  if (($afterResize[2] - $afterResize[0]) -le $beforeWidth -or ($afterResize[3] - $afterResize[1]) -le $beforeHeight) {
    throw 'window_size_did_not_increase'
  }
} finally {
  try {
    if ($resized -and -not [LiguleWindowBounds]::Resize($handle, $before[0], $before[1], $beforeWidth, $beforeHeight)) {
      throw 'set_window_pos_restore_failed'
    }
  } finally {
    if ($madeVisible -and -not $wasVisible) {
      [LiguleWindowBounds]::Hide($handle)
      Start-Sleep -Milliseconds 150
      if ([LiguleWindowBounds]::IsVisible($handle)) { throw 'window_visibility_restore_failed' }
    }
  }
}

Start-Sleep -Milliseconds 250
$restored = [LiguleWindowBounds]::Bounds($handle)
if (($restored[2] - $restored[0]) -ne $beforeWidth -or ($restored[3] - $restored[1]) -ne $beforeHeight) {
  throw 'window_size_restore_mismatch'
}
$visibilityRestored = [LiguleWindowBounds]::IsVisible($handle) -eq $wasVisible
if (-not $visibilityRestored) { throw 'window_visibility_restore_mismatch' }

[pscustomobject]@{
  rootProcessId = $RootProcessId
  ownerProcessId = [LiguleWindowBounds]::OwnerProcessId($handle)
  className = [LiguleWindowBounds]::ClassName($handle)
  title = [LiguleWindowBounds]::Title($handle)
  wasVisible = $wasVisible
  visibleDuringResize = [bool]$madeVisible -or $wasVisible
  visibilityRestored = $visibilityRestored
  before = @{ width = $beforeWidth; height = $beforeHeight }
  resized = @{ width = ($afterResize[2] - $afterResize[0]); height = ($afterResize[3] - $afterResize[1]) }
  restored = $true
} | ConvertTo-Json -Compress
