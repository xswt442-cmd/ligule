import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '../../..');
const desktopRoot = join(repositoryRoot, 'desktop');
const electronRoot = join(desktopRoot, 'electron');
const temporaryRoot = join(desktopRoot, 'testplace', 'tmp');
const evidenceRoot = join(desktopRoot, 'testplace', 'readings');
const electronPackagePath = join(desktopRoot, 'node_modules', 'electron', 'package.json');
const electronBinary = join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const harnessSource = join(testDirectory, 'native-features.cjs');
const report = {
  startedAt: new Date().toISOString(),
  platform: process.platform,
  nodeVersion: process.version,
  cases: {},
  nativeFaults: [],
  notificationClick: { status: 'unverified', reason: '系统通知点击没有可靠的真人等效自动化方式。' },
  savePathRequests: [],
  savePathCompletions: [],
};

if (process.platform !== 'win32') throw new Error('native feature dialog automation currently requires Windows');

const electronPackage = JSON.parse(await readFile(electronPackagePath, 'utf8'));
assert.equal(electronPackage.version, '44.7.0');
assert.ok(isAbsolute(electronBinary));
const runDirectory = join(temporaryRoot, `native-features-${process.pid}-${Date.now()}`);
assertInsideTemporaryRoot(runDirectory);
const appDirectory = join(runDirectory, 'app');
const userDataDirectory = join(runDirectory, 'user-data');
const documentsDirectory = join(runDirectory, 'documents');
const homeDirectory = join(runDirectory, 'ligule-home');
const workspaceDirectory = join(runDirectory, 'workspace');
const powershellScript = join(runDirectory, 'dialog-control.ps1');
const copiedHarness = join(appDirectory, 'native-features.cjs');
let electronProcess;
const pending = new Map();
let nextId = 0;
let readyResolve;
let readyReject;
const ready = new Promise((resolveReady, rejectReady) => {
  readyResolve = resolveReady;
  readyReject = rejectReady;
});
const stderr = [];
const stdout = [];

await Promise.all([
  mkdir(appDirectory, { recursive: true }),
  mkdir(userDataDirectory, { recursive: true }),
  mkdir(documentsDirectory, { recursive: true }),
  mkdir(homeDirectory, { recursive: true }),
  mkdir(workspaceDirectory, { recursive: true }),
]);
await copyFile(harnessSource, copiedHarness);
await writeFile(join(appDirectory, 'package.json'), JSON.stringify({
  name: 'ligule-native-feature-harness',
  version: '0.0.0',
  main: 'native-features.cjs',
}), 'utf8');
await writeFile(powershellScript, dialogControlScript(), 'utf8');

try {
  electronProcess = spawn(electronBinary, [appDirectory], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      LIGULE_HOME: homeDirectory,
      LIGULE_NATIVE_TEST_ROOT: repositoryRoot,
      LIGULE_NATIVE_TEST_USER_DATA: userDataDirectory,
      LIGULE_NATIVE_TEST_DOCUMENTS: documentsDirectory,
      LIGULE_NATIVE_TEST_WORKSPACE: workspaceDirectory,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  assert.ok(electronProcess.pid !== undefined, 'Electron Main must expose its process ID');
  electronProcess.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
  electronProcess.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
  electronProcess.on('message', message => handleMessage(message));
  electronProcess.once('error', error => readyReject(error));
  electronProcess.once('exit', (code, signal) => {
    const detail = Buffer.concat(stderr).toString('utf8');
    const error = new Error(`Electron exited before native feature verification completed (${code}, ${signal}): ${detail}`);
    readyReject(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });

  const mainInfo = await withTimeout(ready, 30_000, 'The shared secure Electron window did not become ready');
  report.electronVersion = mainInfo.electronVersion;
  report.electronPid = mainInfo.pid;
  report.window = 'real BrowserWindow loaded app://ligule/index.html with production Preload';

  report.cases.saveDialogCancel = { status: 'pending' };
  const cancelRequest = sendCommand('save-export-path', 'cancel-export.md', 50_000);
  const cancelControl = runDialogControl('cancel', electronProcess.pid, 'cancel-export.md');
  const [cancelResult, cancelReadout] = await Promise.all([cancelRequest, cancelControl]);
  report.cases.saveDialogCancel = { result: cancelResult, automation: cancelReadout };
  assert.equal(cancelResult, null, 'the native dialog cancel button must return null');
  assert.equal(cancelReadout.action, 'cancel');

  const selectedPath = join(documentsDirectory, 'selected-export.md');
  report.cases.saveDialogSelection = { status: 'pending' };
  const selectedRequest = sendCommand('save-export-path', 'selected-export.md', 50_000);
  const selectControl = runDialogControl('select', electronProcess.pid, selectedPath);
  const [selectedResult, selectReadout] = await Promise.all([selectedRequest, selectControl]);
  report.cases.saveDialogSelection = {
    result: selectedResult,
    automation: selectReadout,
    selectedFileCreated: false,
  };
  assert.equal(resolve(selectedResult), resolve(selectedPath), 'the dialog must return the selected path');
  assert.equal(selectReadout.action, 'select');
  assert.equal(await fileExists(selectedPath), false, 'choosing an export location must not write the export file');

  const exportSessions = await sendCommand('prepare-export-sessions');
  assert.ok(typeof exportSessions.sessionA === 'string' && typeof exportSessions.sessionB === 'string');
  const invalidExport = await sendCommand('invalid-export-path', exportSessions.sessionA);
  report.cases.invalidExportPath = invalidExport;
  assert.equal(invalidExport.error, 'host_export_write_failed');
  assert.equal(invalidExport.blocker, 'preserve this file');
  assert.equal(invalidExport.targetExists, false);

  const notificationFor = sessionId => ({
    title: 'ligule',
    body: 'Turn completed',
    target: JSON.stringify({ sessionId, projectRoot: workspaceDirectory }),
    openLabel: 'Open conversation',
  });
  report.cases.notificationA = await sendCommand('show-notification', notificationFor(exportSessions.sessionA), 15_000);
  report.cases.notificationAClick = await sendCommand('click-latest-notification');
  assert.equal(JSON.parse(report.cases.notificationAClick.target).sessionId, exportSessions.sessionA);
  await waitForSessionTitle('Export race A');
  const staleExportPath = join(documentsDirectory, `ligule-${exportSessions.sessionA.slice(0, 8)}.md`);
  assert.equal(await fileExists(staleExportPath), false);
  report.cases.exportPanelOpen = await sendCommand('open-export-panel');
  assert.equal(report.cases.exportPanelOpen?.error, undefined, `could not open ExportPanel: ${report.cases.exportPanelOpen?.error ?? 'unknown error'}`);
  report.cases.notificationB = await sendCommand('show-notification', notificationFor(exportSessions.sessionB), 15_000);
  report.cases.exportPanelBeforeClick = await sendCommand('inspect-export-ui');
  report.cases.exportButtonClick = await sendCommand('click-export');
  assert.equal(report.cases.exportButtonClick?.error, undefined, `could not click ExportPanel: ${report.cases.exportButtonClick?.error ?? 'unknown error'}`);
  report.cases.exportPanelAfterClick = await sendCommand('inspect-export-ui');
  const staleDialog = await runDialogControl('observe', electronProcess.pid, staleExportPath);
  report.cases.notificationBClick = await sendCommand('click-latest-notification');
  assert.equal(JSON.parse(report.cases.notificationBClick.target).sessionId, exportSessions.sessionB);
  const deliveredTarget = await waitForNotificationTarget(exportSessions.sessionB);
  const staleSelection = await runDialogControl('select', electronProcess.pid, staleExportPath);
  const stalePickerResult = await waitForSavePathResult(`ligule-${exportSessions.sessionA.slice(0, 8)}.md`);
  assert.equal(resolve(stalePickerResult.selectedPath), resolve(staleExportPath), 'the stale picker must return the exact path inside the isolated documents directory');
  const switchedTitle = await waitForSessionTitle('Export race B');
  await delay(400);
  const staleExportWritten = await fileExists(staleExportPath);
  report.cases.exportAfterNotificationSessionSwitch = {
    previousSession: 'Export race A',
    notificationTargetDelivered: deliveredTarget,
    activeSession: switchedTitle,
    dialogObserved: staleDialog.action === 'observe',
    selectedPath: staleSelection.selectedPath,
    pickerResult: stalePickerResult.selectedPath,
    fileCreatedAfterPanelUnmount: staleExportWritten,
  };
  assert.equal(staleExportWritten, false, 'a save dialog result for an unmounted session must not start Host export');

  const reopenedExportPanel = await sendCommand('open-export-panel');
  report.cases.exportPanelReopenedAfterSwitch = { label: reopenedExportPanel };
  assert.match(reopenedExportPanel, /导出会话|Export session/u);
  const cancelledExportPath = join(documentsDirectory, `ligule-${exportSessions.sessionB.slice(0, 8)}.md`);
  const cancelledExportName = `ligule-${exportSessions.sessionB.slice(0, 8)}.md`;
  const beforeCancelCompletion = report.savePathCompletions.length;
  await sendCommand('click-export');
  const cancelledDialog = await runDialogControl('cancel', electronProcess.pid, cancelledExportPath);
  const cancelledPickerResult = await waitForSavePathResult(cancelledExportName, beforeCancelCompletion);
  await delay(250);
  report.cases.exportDialogCancel = {
    result: cancelledPickerResult.selectedPath,
    automation: cancelledDialog,
    fileCreated: await fileExists(cancelledExportPath),
  };
  assert.equal(cancelledDialog.action, 'cancel');
  assert.equal(report.cases.exportDialogCancel.result, null);
  assert.equal(report.cases.exportDialogCancel.fileCreated, false, 'a cancelled dialog must not produce an export file');

  const trayUpdate = await sendCommand('update-tray');
  assert.equal(trayUpdate, undefined);
  report.cases.tray = await sendCommand('inspect-tray-window');

  const notification = {
    title: 'ligule',
    body: 'Turn completed',
    target: JSON.stringify({ sessionId: '7b52f58e-2d65-4a49-b62f-1ba3f7064421', projectRoot: '' }),
    openLabel: 'Open conversation',
  };
  const faultCount = report.nativeFaults.length;
  const notificationStarted = Date.now();
  const notificationResult = await sendCommand('show-notification', notification, 15_000);
  const notificationDurationMs = Date.now() - notificationStarted;
  const notificationFaults = report.nativeFaults.slice(faultCount).filter(item => item.code === 'notification-show-failed');
  const notificationStatus = notificationResult?.error === undefined
    ? 'shown-event'
    : notificationDurationMs >= 9_000 ? 'no-native-event-before-timeout' : 'native-failed-event';
  report.cases.notification = {
    status: notificationStatus,
    durationMs: notificationDurationMs,
    result: notificationResult,
    faults: notificationFaults,
    payload: notification,
  };
  if (notificationStatus === 'no-native-event-before-timeout') {
    throw new Error('Electron did not emit a native notification show or failed event before the ten second timeout');
  }

  assert.equal(report.cases.tray.canHide, true, 'the real Windows Tray API must permit the hide path');
  assert.equal(report.cases.tray.hidden, true, 'BrowserWindow.hide() must hide the real window');
  assert.equal(report.cases.tray.restored, true, 'NativeServices.restore() must show the real window');
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (electronProcess !== undefined && electronProcess.exitCode === null && electronProcess.signalCode === null) {
    try { await sendCommand('shutdown', undefined, 5_000); } catch { /* Continue with PID-verified cleanup. */ }
    await waitForProcessExit(electronProcess, 8_000).catch(async () => {
      const rows = await queryProcesses([electronProcess.pid]);
      const main = rows.find(row => row.ProcessId === electronProcess?.pid);
      if (main?.CommandLine?.includes(appDirectory)) electronProcess?.kill();
      if (electronProcess !== undefined) await waitForProcessExit(electronProcess, 5_000).catch(() => undefined);
    });
  }
  report.finishedAt = new Date().toISOString();
  report.electronStdout = Buffer.concat(stdout).toString('utf8').slice(-8_000);
  report.electronStderr = Buffer.concat(stderr).toString('utf8').slice(-8_000);
  await mkdir(evidenceRoot, { recursive: true });
  const evidencePath = join(evidenceRoot, 'native-features-windows.json');
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`Native feature evidence: ${evidencePath}\n`);
  const remaining = await queryProcesses(electronProcess?.pid === undefined ? [] : [electronProcess.pid]);
  if (remaining.length > 0 && remaining[0].CommandLine?.includes(appDirectory)) {
    throw new Error('the test-owned Electron process remains after shutdown');
  }
  await removeTemporaryDirectory(runDirectory);
}

function handleMessage(message) {
  if (message === null || typeof message !== 'object') return;
  if (message.type === 'ready') {
    readyResolve(message);
    return;
  }
  if (message.type === 'startup-failed') {
    readyReject(new Error(`Electron native harness startup failed: ${message.message}`));
    return;
  }
  if (message.type === 'native-fault') {
    report.nativeFaults.push({ code: message.code, at: new Date().toISOString() });
    return;
  }
  if (message.type === 'notification-open') {
    report.notificationClickObserved = message.target;
    return;
  }
  if (message.type === 'save-path-requested') {
    report.savePathRequests.push({ defaultName: message.defaultName, at: new Date().toISOString() });
    return;
  }
  if (message.type === 'save-path-completed') {
    report.savePathCompletions.push({ defaultName: message.defaultName, selectedPath: message.selectedPath, at: new Date().toISOString() });
    return;
  }
  if (message.type === 'result') {
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) waiter.resolve({ error: message.error });
    else waiter.resolve(message.value);
  }
}

function sendCommand(action, value, timeoutMs = 20_000) {
  if (electronProcess === undefined || !electronProcess.connected) return Promise.reject(new Error('Electron IPC channel is unavailable'));
  const id = String(++nextId);
  const promise = withTimeout(new Promise((resolveResult, rejectResult) => pending.set(id, { resolve: resolveResult, reject: rejectResult })), timeoutMs, `Electron did not complete ${action}`)
    .finally(() => pending.delete(id));
  const message = { id, action };
  if (action === 'show-notification') message.notification = value;
  else if (action === 'save-export-path') message.defaultName = value;
  else if (value !== undefined) message.value = value;
  electronProcess.send(message, error => {
    if (error !== null && error !== undefined) {
      pending.get(id)?.reject(error);
      pending.delete(id);
    }
  });
  return promise;
}

async function runDialogControl(mode, ownerPid, targetPath) {
  const result = await runPowerShell(powershellScript, [mode, String(ownerPid), targetPath], 40_000);
  return JSON.parse(result);
}

async function waitForSessionTitle(expected) {
  const deadline = Date.now() + 20_000;
  let actual = '';
  while (Date.now() < deadline) {
    actual = await sendCommand('session-title', undefined, 5_000);
    if (actual === expected) return actual;
    await delay(100);
  }
  throw new Error(`notification_target_session_not_opened:${expected}:${actual}`);
}

async function waitForNotificationTarget(sessionId) {
  const deadline = Date.now() + 10_000;
  let targets = [];
  while (Date.now() < deadline) {
    targets = await sendCommand('notification-targets', undefined, 5_000);
    const target = targets.map(value => {
      try { return typeof value === 'string' ? JSON.parse(value) : value; }
      catch { return null; }
    }).find(value => value?.sessionId === sessionId);
    if (target !== undefined) return target;
    await delay(50);
  }
  throw new Error(`notification_target_not_delivered_to_renderer:${sessionId}:${JSON.stringify(targets)}`);
}

async function waitForSavePathResult(defaultName, afterIndex = 0) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = report.savePathCompletions.slice(afterIndex).find(item => item.defaultName === defaultName);
    if (result !== undefined) return result;
    await delay(50);
  }
  throw new Error(`native_save_path_result_missing:${defaultName}:${JSON.stringify(report.savePathCompletions)}`);
}

function runPowerShell(scriptPath, args, timeoutMs) {
  return new Promise((resolveOutput, rejectOutput) => {
    const powershell = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-File', scriptPath, ...args], {
      cwd: repositoryRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => powershell.kill(), timeoutMs);
    powershell.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
    powershell.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
    powershell.once('error', error => { clearTimeout(timer); rejectOutput(error); });
    powershell.once('exit', code => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8').trim();
      if (code !== 0) {
        rejectOutput(new Error(`PowerShell dialog control failed (${code}): ${Buffer.concat(stderr).toString('utf8')} ${output}`));
        return;
      }
      resolveOutput(output);
    });
  });
}

function dialogControlScript() {
  return `param([string]$Mode, [int]$OwnerProcessId, [string]$TargetPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class NativeTestWindowEnumeration {
  private delegate bool EnumWindowsCallback(IntPtr window, IntPtr state);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr state);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, System.Text.StringBuilder text, int maximum);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", EntryPoint="GetDlgCtrlID")] private static extern int GetDialogControlId(IntPtr control);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="GetClassNameW")] private static extern int GetClassName(IntPtr control, System.Text.StringBuilder name, int maximum);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsCallback callback, IntPtr state);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="GetWindowTextW")] private static extern int GetWindowTextW(IntPtr window, System.Text.StringBuilder text, int maximum);
  [DllImport("user32.dll", EntryPoint="SendMessageW")] private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  public static IntPtr[] ForProcess(uint targetProcessId) {
    var windows = new List<IntPtr>();
    EnumWindows((window, state) => {
      uint processId;
      GetWindowThreadProcessId(window, out processId);
      if (processId == targetProcessId && IsWindowVisible(window)) windows.Add(window);
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }
  public static uint OwnerProcess(IntPtr window) {
    uint processId;
    GetWindowThreadProcessId(window, out processId);
    return processId;
  }
  public static string Title(IntPtr window) {
    var text = new System.Text.StringBuilder(512);
    GetWindowText(window, text, text.Capacity);
    return text.ToString();
  }
  public static bool Exists(IntPtr window) { return IsWindow(window); }
  public static string[] ChildControls(IntPtr dialog) {
    var controls = new List<string>();
    EnumChildWindows(dialog, (control, state) => {
      var className = new System.Text.StringBuilder(256);
      GetClassName(control, className, className.Capacity);
      var text = new System.Text.StringBuilder(512);
      GetWindowTextW(control, text, text.Capacity);
      controls.Add(GetDialogControlId(control) + ":" + className + ":" + text);
      return true;
    }, IntPtr.Zero);
    return controls.ToArray();
  }
  public static void InvokeDialogCommand(IntPtr dialog, int commandId) {
    SendMessage(dialog, 0x0111, new IntPtr(commandId), IntPtr.Zero);
  }
}
'@
$deadline = (Get-Date).AddSeconds(35)
$dialog = $null
$dialogHandle = [IntPtr]::Zero
$lastWindows = @()
while ((Get-Date) -lt $deadline -and $null -eq $dialog) {
  $windows = [NativeTestWindowEnumeration]::ForProcess([uint32]$OwnerProcessId)
  $lastWindows = @()
  foreach ($handle in $windows) {
    $lastWindows += [NativeTestWindowEnumeration]::Title($handle)
    try {
      $window = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
      $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      $controls = @($elements | ForEach-Object { if ($_.Current.Name -ne '') { $_.Current.ControlType.ProgrammaticName + ':' + $_.Current.Name + '#' + $_.Current.AutomationId } })
      $lastWindows += ('  Controls: ' + (($controls | Select-Object -First 80) -join ' | '))
      $ids = @($elements | ForEach-Object { [string]$_.Current.AutomationId })
      if ($ids -contains '1' -and $ids -contains '2' -and $ids -contains '1001') { $dialog = $window; $dialogHandle = $handle; break }
    } catch { $lastWindows += ('UIAutomation unavailable: ' + $_.Exception.Message) }
  }
  if ($null -eq $dialog) { Start-Sleep -Milliseconds 250 }
}
if ($null -eq $dialog) { throw ('Owned Save dialog was not found. Owned windows: ' + ($lastWindows -join ' | ')) }
$dialogTitle = [NativeTestWindowEnumeration]::Title($dialogHandle)
$fileNameCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1001')
$expectedFileName = [System.IO.Path]::GetFileName($TargetPath)
$expectedDisplayStem = [System.IO.Path]::GetFileNameWithoutExtension($TargetPath)
$fileNameField = $null
$fileNameValue = $null
$fileNameSource = $null
$stableFileNameReads = 0
$fileNameDeadline = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $fileNameDeadline -and $stableFileNameReads -lt 2) {
  $fileNameField = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $fileNameCondition)
  if ($null -ne $fileNameField) {
    try {
      $valuePattern = $fileNameField.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $observedFileName = $valuePattern.Current.Value
      if ($observedFileName -ne '') { $fileNameSource = 'ValuePattern' }
      else { $observedFileName = $fileNameField.Current.Name; $fileNameSource = 'NameFallbackForEmptyValuePattern' }
    } catch {
      $observedFileName = $fileNameField.Current.Name
      $fileNameSource = 'NameFallbackForUnsupportedValuePattern'
    }
    # Windows can hide a known extension in the filename control; the returned full path is checked by the caller.
    if ($observedFileName -eq $expectedFileName -or $observedFileName -eq $expectedDisplayStem) { $stableFileNameReads += 1 }
    else { $stableFileNameReads = 0 }
    $fileNameValue = $observedFileName
  }
  if ($stableFileNameReads -lt 2) { Start-Sleep -Milliseconds 100 }
}
if ($stableFileNameReads -lt 2) {
  $fieldName = if ($null -eq $fileNameField) { '<missing>' } else { $fileNameField.Current.Name }
  $fieldAutomationId = if ($null -eq $fileNameField) { '<missing>' } else { $fileNameField.Current.AutomationId }
  throw ('Save dialog filename mismatch: expected=' + $expectedFileName + ' observed=' + $fileNameValue + ' source=' + $fileNameSource + ' name=' + $fieldName + ' automationId=' + $fieldAutomationId)
}
$leaveOpen = $false
if ($Mode -eq 'cancel') {
  [NativeTestWindowEnumeration]::InvokeDialogCommand($dialogHandle, 2)
} elseif ($Mode -eq 'observe') {
  $leaveOpen = $true
} elseif ($Mode -eq 'select') {
  [NativeTestWindowEnumeration]::InvokeDialogCommand($dialogHandle, 1)
} else { throw 'Unknown dialog action' }
if (-not $leaveOpen -and ($Mode -eq 'cancel' -or $Mode -eq 'select')) {
  $closeDeadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $closeDeadline -and [NativeTestWindowEnumeration]::Exists($dialogHandle)) {
    Start-Sleep -Milliseconds 200
  }
}
if (-not $leaveOpen -and ($Mode -eq 'cancel' -or $Mode -eq 'select') -and [NativeTestWindowEnumeration]::Exists($dialogHandle) -and [NativeTestWindowEnumeration]::OwnerProcess($dialogHandle) -eq $OwnerProcessId -and [NativeTestWindowEnumeration]::Title($dialogHandle) -eq $dialogTitle) { throw 'The Save dialog remained open after the button action' }
[pscustomobject]@{ action = $Mode; ownerPid = $OwnerProcessId; dialogTitle = $dialogTitle; dialogHandle = $dialogHandle.ToInt64(); selectedPath = $(if ($Mode -eq 'select') { $TargetPath } else { $null }); closed = -not [NativeTestWindowEnumeration]::Exists($dialogHandle) } | ConvertTo-Json -Compress
`;
}

async function queryProcesses(pids) {
  if (pids.length === 0) return [];
  const ids = pids.filter(Number.isSafeInteger).join(',');
  const script = `$rows = @(); foreach ($processId in @(${ids})) { $item = Get-CimInstance Win32_Process -Filter (\"ProcessId = $processId\") -ErrorAction SilentlyContinue; if ($null -ne $item) { $rows += [pscustomobject]@{ ProcessId=[int]$item.ProcessId; ParentProcessId=[int]$item.ParentProcessId; Name=$item.Name; CommandLine=$item.CommandLine } } }; ConvertTo-Json -InputObject $rows -Compress`;
  const output = await runPowerShellCommand(script);
  const parsed = JSON.parse(output || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

function runPowerShellCommand(script) {
  return new Promise((resolveOutput, rejectOutput) => {
    const powershell = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    powershell.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
    powershell.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
    powershell.once('error', rejectOutput);
    powershell.once('exit', code => {
      if (code !== 0) rejectOutput(new Error(`Win32_Process query failed: ${Buffer.concat(stderr).toString('utf8')}`));
      else resolveOutput(Buffer.concat(stdout).toString('utf8').trim());
    });
  });
}

async function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await withTimeout(new Promise(resolveExit => child.once('exit', resolveExit)), timeoutMs, 'Electron did not exit');
}

async function fileExists(path) {
  try { await realpath(path); return true; } catch { return false; }
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertInsideTemporaryRoot(target) {
  const base = resolve(temporaryRoot);
  const absolute = resolve(target);
  const child = relative(base, absolute);
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`refusing to write or remove outside desktop/testplace/tmp: ${absolute}`);
  }
}

async function removeTemporaryDirectory(path) {
  assertInsideTemporaryRoot(path);
  await rm(path, { recursive: true, force: true });
}
