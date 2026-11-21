import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How a program run on a console of its own ended once that console was closed. */
export interface ClosedConsoleRun {
	/** The program's exit status, read through its process handle, or `undefined` if it outlived the wait. */
	readonly exitCode: number | undefined;
	/** How long after the close the program exited, by the operating system's record of its exit. */
	readonly exitedAfterMs: number | undefined;
	/** Whether the process whose pid the ready file holds had exited by the end of the wait after the close. */
	readonly readyProcessExited: boolean;
	/** What the program wrote to its console before it was closed. */
	readonly screen: string;
}

export interface ClosedConsoleOptions {
	/** The command line to run, as CreateProcess takes it. */
	readonly commandLine: string;
	readonly cwd: string;
	/** The program's environment. */
	readonly env: Record<string, string>;
	/**
	 * The console is closed once this file holds a pid and the screen shows `readyText`. That process, which must be
	 * a child of the program, is watched through a handle opened before the close, as the program itself is.
	 */
	readonly readyFile: string;
	readonly readyText: string;
	/** How long to wait for the program to be ready, and then for it to exit after the close. */
	readonly timeoutMs: number;
	/** How long the process the ready file names may take to exit once the program has. */
	readonly readyProcessExitMs: number;
	/** Where the helper script is written. */
	readonly directory: string;
}

// Starts the program on a pseudoconsole, the console Windows Terminal and other terminals give a program, and closes
// that console as such a terminal does when its window or tab is closed: Windows then sends the program the console's
// close event. The program's status comes from a handle opened when it started, so a reused pid cannot answer.
const CLOSE_SCRIPT = String.raw`
param([string]$ParamsFile, [string]$ResultFile)
$ErrorActionPreference = 'Stop'
$params = Get-Content -Raw -Encoding UTF8 -LiteralPath $ParamsFile | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class AtomicClosedConsole {
  [StructLayout(LayoutKind.Sequential)] struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY;
    public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
    public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput;
    public IntPtr hStdOutput; public IntPtr hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, IntPtr attributes, int size);
  [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(COORD size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr console);
  [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr console);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION info);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_BASIC_INFORMATION { public IntPtr ExitStatus; public IntPtr PebBaseAddress; public IntPtr AffinityMask; public IntPtr BasePriority; public IntPtr UniqueProcessId; public IntPtr InheritedFromUniqueProcessId; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, ref PROCESS_BASIC_INFORMATION info, int length, out int returned);
  static IntPtr console; static PROCESS_INFORMATION child; static SafeFileHandle input; static IntPtr watched = IntPtr.Zero;
  static readonly StringBuilder screen = new StringBuilder();
  public static void Start(string commandLine, string cwd) {
    SafeFileHandle inputRead, inputWrite, outputRead, outputWrite;
    if (!CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 0) || !CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 0)) throw new Exception("CreatePipe " + Marshal.GetLastWin32Error());
    COORD size; size.X = 120; size.Y = 40;
    int result = CreatePseudoConsole(size, inputRead, outputWrite, 0, out console);
    if (result != 0) throw new Exception("CreatePseudoConsole " + result);
    inputRead.Dispose(); outputWrite.Dispose();
    // The terminal's side: keep reading the screen, so the program's writes never wait on a full pipe. Its input is
    // held open, unused, until the end.
    input = inputWrite;
    var reader = new FileStream(outputRead, FileAccess.Read);
    var thread = new Thread(() => { var buffer = new byte[65536]; try { int read; while ((read = reader.Read(buffer, 0, buffer.Length)) > 0) lock (screen) screen.Append(Encoding.UTF8.GetString(buffer, 0, read)); } catch {} });
    thread.IsBackground = true; thread.Start();
    IntPtr listSize = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref listSize);
    var startup = new STARTUPINFOEX(); startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
    // STARTF_USESTDHANDLES with invalid handles: the program's standard handles are the pseudoconsole's.
    startup.StartupInfo.dwFlags = 0x100; startup.StartupInfo.hStdInput = (IntPtr)(-1); startup.StartupInfo.hStdOutput = (IntPtr)(-1); startup.StartupInfo.hStdError = (IntPtr)(-1);
    startup.lpAttributeList = Marshal.AllocHGlobal(listSize);
    if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, ref listSize)) throw new Exception("InitializeProcThreadAttributeList " + Marshal.GetLastWin32Error());
    // PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
    if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, (IntPtr)0x20016, console, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) throw new Exception("UpdateProcThreadAttribute " + Marshal.GetLastWin32Error());
    // EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT; the environment is this process's.
    if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, 0x00080000 | 0x00000400, IntPtr.Zero, cwd, ref startup, out child)) throw new Exception("CreateProcess " + Marshal.GetLastWin32Error());
  }
  public static string Screen() { lock (screen) return screen.ToString(); }
  // A terminal closes its pseudoconsole from a thread that may block until the console's programs have exited. The
  // close is timed on that thread, just before it, so a late start of the thread does not count.
  public static long Close() {
    long closedAt = 0; var timed = new ManualResetEvent(false);
    var closer = new Thread(() => { closedAt = DateTime.UtcNow.ToFileTimeUtc(); timed.Set(); ClosePseudoConsole(console); });
    closer.IsBackground = true; closer.Start(); timed.WaitOne();
    return closedAt;
  }
  static long CreatedAt(IntPtr handle) { long creation, exit, kernel, user; GetProcessTimes(handle, out creation, out exit, out kernel, out user); return creation; }
  // SYNCHRONIZE | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION: the handle names this process, not its pid.
  // It is kept only for a process the program started: one its parent is, and created after it. The program's own
  // handle keeps its pid from naming another process meanwhile.
  public static bool Watch(int pid) {
    IntPtr handle = OpenProcess(0x00100000 | 0x0001 | 0x1000, false, pid);
    if (handle == IntPtr.Zero) return false;
    var info = new PROCESS_BASIC_INFORMATION(); int returned;
    bool ours = NtQueryInformationProcess(handle, 0, ref info, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out returned) == 0
      && info.InheritedFromUniqueProcessId.ToInt64() == child.dwProcessId && CreatedAt(handle) >= CreatedAt(child.hProcess);
    if (!ours) { CloseHandle(handle); return false; }
    watched = handle; return true;
  }
  public static bool WatchedExited(int ms) { return watched != IntPtr.Zero && WaitForSingleObject(watched, (uint)ms) == 0; }
  // Ends what this helper started and is still running, through the handles it holds.
  public static void EndLeftovers() {
    if (child.hProcess != IntPtr.Zero && WaitForSingleObject(child.hProcess, 0) != 0) TerminateProcess(child.hProcess, 1);
    if (watched != IntPtr.Zero && WaitForSingleObject(watched, 0) != 0) TerminateProcess(watched, 1);
  }
  public static bool WaitForExit(int ms) { return WaitForSingleObject(child.hProcess, (uint)ms) == 0; }
  public static uint ExitCode() { uint code; GetExitCodeProcess(child.hProcess, out code); return code; }
  public static long ExitedAt() { long creation, exit, kernel, user; GetProcessTimes(child.hProcess, out creation, out exit, out kernel, out user); return exit; }
}
'@
try {
  [AtomicClosedConsole]::Start($params.commandLine, $params.cwd)
  $deadline = [DateTime]::UtcNow.AddMilliseconds($params.timeoutMs)
  $readyPid = 0
  while ($true) {
    if ($readyPid -eq 0 -and (Test-Path -LiteralPath $params.readyFile)) {
      $text = [IO.File]::ReadAllText($params.readyFile)
      if ($text -match '^\d+$') {
        $readyPid = [int]$text
        if (-not [AtomicClosedConsole]::Watch($readyPid)) { throw "process $readyPid is not one the program started" }
      }
    }
    if ($readyPid -ne 0 -and [AtomicClosedConsole]::Screen().Contains($params.readyText)) { break }
    if ([DateTime]::UtcNow -gt $deadline -or [AtomicClosedConsole]::WaitForExit(0)) { throw "the program was not ready: $([AtomicClosedConsole]::Screen())" }
    Start-Sleep -Milliseconds 50
  }
  $closedAt = [AtomicClosedConsole]::Close()
  $exited = [AtomicClosedConsole]::WaitForExit($params.timeoutMs)
  $result = @{ screen = [AtomicClosedConsole]::Screen() }
  if ($exited) {
    $result.exitCode = [AtomicClosedConsole]::ExitCode()
    $result.exitedAfterMs = ([AtomicClosedConsole]::ExitedAt() - $closedAt) / 10000
  }
  $result.readyProcessExited = [AtomicClosedConsole]::WatchedExited($params.readyProcessExitMs)
  [IO.File]::WriteAllText($ResultFile, ($result | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
} finally {
  [AtomicClosedConsole]::EndLeftovers()
}
`;

interface CloseReport {
	readonly screen: string;
	readonly exitCode?: number;
	readonly exitedAfterMs?: number;
	readonly readyProcessExited: boolean;
}

/**
 * Windows only: run a program on a console of its own until it is ready, close that console as closing a terminal's
 * window does, and report how the program ended. The program, and the process its ready file names, are ended through
 * the helper's handles if they still run once the wait is over or the helper fails.
 */
export async function runUntilConsoleClosed(options: ClosedConsoleOptions): Promise<ClosedConsoleRun> {
	const script = join(options.directory, "close-console.ps1");
	const params = join(options.directory, "close-console.json");
	const result = join(options.directory, "close-console-result.json");
	writeFileSync(script, CLOSE_SCRIPT);
	writeFileSync(
		params,
		JSON.stringify({
			commandLine: options.commandLine,
			cwd: options.cwd,
			readyFile: options.readyFile,
			readyText: options.readyText,
			timeoutMs: options.timeoutMs,
			readyProcessExitMs: options.readyProcessExitMs,
		}),
	);
	const helper = spawn(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, params, result],
		{ env: options.env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
	);
	let stderr = "";
	helper.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const code = await new Promise<number | null>((resolve, reject) => {
		helper.once("error", reject);
		helper.once("close", resolve);
	});
	if (code !== 0) throw new Error(`the console helper failed with ${code}: ${stderr}`);
	const report = JSON.parse(readFileSync(result, "utf8")) as CloseReport;
	return {
		exitCode: report.exitCode,
		exitedAfterMs: report.exitedAfterMs,
		readyProcessExited: report.readyProcessExited,
		screen: report.screen,
	};
}
