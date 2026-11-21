import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Atomic's hidden window, which hears the end of the Windows session, as another program sees it. */
export interface SessionEndWindow {
	readonly title: string;
	readonly visible: boolean;
	/** Whether the desktop is its parent: a top-level window, the only kind Windows tells that the session ends. */
	readonly topLevel: boolean;
	readonly extendedStyle: number;
}

/** How a program run on a console of its own ended once Windows said the session ends. */
export interface EndedSessionRun {
	readonly window: SessionEndWindow;
	/** The window's answer to WM_QUERYENDSESSION: 1 lets the session end. */
	readonly queryAnswer: number;
	/** Whether the program still ran half a second after another program cancelled the end (WM_ENDSESSION FALSE). */
	readonly ranAfterCancel: boolean;
	/** How long the window held WM_ENDSESSION(TRUE) before it answered or its process was gone. */
	readonly heldMs: number;
	/** The program's exit status, read through its process handle, or `undefined` if it outlived the wait. */
	readonly exitCode: number | undefined;
	/** How long after WM_ENDSESSION(TRUE) was sent the program exited, by the operating system's record of its exit. */
	readonly exitedAfterMs: number | undefined;
	/** Whether the process whose pid the ready file holds had exited by the end of the wait. */
	readonly readyProcessExited: boolean;
	/** What the program wrote to its console. */
	readonly screen: string;
}

export interface EndedSessionOptions {
	/** The command line to run, as CreateProcess takes it. */
	readonly commandLine: string;
	readonly cwd: string;
	/** The program's environment. */
	readonly env: Record<string, string>;
	/**
	 * The session is ended once this file holds a pid, the screen shows `readyText` and the program has its window.
	 * That process, which must be a child of the program, is watched through a handle, as the program itself is.
	 */
	readonly readyFile: string;
	readonly readyText: string;
	/** How long to wait for the program to be ready, and then for it to exit after the end of the session. */
	readonly timeoutMs: number;
	/** How long the process the ready file names may take to exit once the program has. */
	readonly readyProcessExitMs: number;
	/** Where the helper script is written. */
	readonly directory: string;
}

// Starts the program on a pseudoconsole, the console Windows Terminal and other terminals give a program. Once it is
// ready, sends its hidden window what Windows sends every top-level window when the user signs out: WM_QUERYENDSESSION,
// then WM_ENDSESSION, first as when another program cancels the sign-out (FALSE), then as when it goes ahead (TRUE).
// Windows ends a program once its window returns from WM_ENDSESSION(TRUE); this helper only waits for its exit.
const SESSION_END_SCRIPT = String.raw`
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
public static class AtomicEndedSession {
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
  delegate bool EnumWindowsProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr window, StringBuilder name, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr window, StringBuilder text, int size);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] static extern IntPtr GetWindowLongPtrW(IntPtr window, int index);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeoutMs, out IntPtr result);
  static IntPtr console; static PROCESS_INFORMATION child; static SafeFileHandle input; static IntPtr watched = IntPtr.Zero;
  static IntPtr window = IntPtr.Zero;
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
  static long CreatedAt(IntPtr handle) { long creation, exit, kernel, user; GetProcessTimes(handle, out creation, out exit, out kernel, out user); return creation; }
  // SYNCHRONIZE | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION: the handle names this process, not its pid.
  // It is kept only for a process the program started: one its parent is, and created after it.
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
  // The program's window of the class Atomic gives the window that hears the end of the session.
  public static bool FindWindow() {
    EnumWindows((candidate, data) => {
      uint pid; GetWindowThreadProcessId(candidate, out pid);
      if (pid != (uint)child.dwProcessId) return true;
      var name = new StringBuilder(256); GetClassNameW(candidate, name, name.Capacity);
      if (name.ToString() != "AtomicSessionEnd") return true;
      window = candidate; return false;
    }, IntPtr.Zero);
    return window != IntPtr.Zero;
  }
  public static string Title() { var text = new StringBuilder(256); GetWindowTextW(window, text, text.Capacity); return text.ToString(); }
  public static bool Visible() { return IsWindowVisible(window); }
  // GA_PARENT: a message-only window's parent is not the desktop.
  public static bool TopLevel() { return GetAncestor(window, 1) == GetDesktopWindow(); }
  // GWL_EXSTYLE
  public static long ExtendedStyle() { return GetWindowLongPtrW(window, -20).ToInt64(); }
  // ENDSESSION_LOGOFF, as for a sign-out. SMTO_NORMAL: wait as Windows does, up to the timeout.
  public static long Send(uint message, long wParam, uint timeoutMs) {
    IntPtr result; SendMessageTimeoutW(window, message, (IntPtr)wParam, new IntPtr(0x80000000L), 0, timeoutMs, out result);
    return result.ToInt64();
  }
  // Ends what this helper started and is still running, through the handles it holds, and closes the console.
  public static void EndLeftovers() {
    if (child.hProcess != IntPtr.Zero && WaitForSingleObject(child.hProcess, 0) != 0) TerminateProcess(child.hProcess, 1);
    if (watched != IntPtr.Zero && WaitForSingleObject(watched, 0) != 0) TerminateProcess(watched, 1);
    if (console != IntPtr.Zero) { var closer = new Thread(() => ClosePseudoConsole(console)); closer.IsBackground = true; closer.Start(); }
  }
  public static bool WaitForExit(int ms) { return WaitForSingleObject(child.hProcess, (uint)ms) == 0; }
  public static uint ExitCode() { uint code; GetExitCodeProcess(child.hProcess, out code); return code; }
  public static long ExitedAt() { long creation, exit, kernel, user; GetProcessTimes(child.hProcess, out creation, out exit, out kernel, out user); return exit; }
}
'@
try {
  [AtomicEndedSession]::Start($params.commandLine, $params.cwd)
  $deadline = [DateTime]::UtcNow.AddMilliseconds($params.timeoutMs)
  $readyPid = 0
  while ($true) {
    if ($readyPid -eq 0 -and (Test-Path -LiteralPath $params.readyFile)) {
      $text = [IO.File]::ReadAllText($params.readyFile)
      if ($text -match '^\d+$') {
        $readyPid = [int]$text
        if (-not [AtomicEndedSession]::Watch($readyPid)) { throw "process $readyPid is not one the program started" }
      }
    }
    if ($readyPid -ne 0 -and [AtomicEndedSession]::Screen().Contains($params.readyText) -and [AtomicEndedSession]::FindWindow()) { break }
    if ([DateTime]::UtcNow -gt $deadline -or [AtomicEndedSession]::WaitForExit(0)) { throw "the program was not ready: $([AtomicEndedSession]::Screen())" }
    Start-Sleep -Milliseconds 50
  }
  $result = @{
    window = @{
      title = [AtomicEndedSession]::Title(); visible = [AtomicEndedSession]::Visible()
      topLevel = [AtomicEndedSession]::TopLevel(); extendedStyle = [AtomicEndedSession]::ExtendedStyle()
    }
  }
  # WM_QUERYENDSESSION, then WM_ENDSESSION(FALSE): another program cancelled the sign-out.
  $result.queryAnswer = [AtomicEndedSession]::Send(0x11, 0, 10000)
  [void][AtomicEndedSession]::Send(0x16, 0, 10000)
  $result.ranAfterCancel = -not [AtomicEndedSession]::WaitForExit(500)
  # WM_ENDSESSION(TRUE): the sign-out goes ahead.
  $sentAt = [DateTime]::UtcNow.ToFileTimeUtc()
  $clock = [Diagnostics.Stopwatch]::StartNew()
  [void][AtomicEndedSession]::Send(0x16, 1, [uint32]$params.timeoutMs)
  $result.heldMs = $clock.ElapsedMilliseconds
  if ([AtomicEndedSession]::WaitForExit($params.timeoutMs)) {
    $result.exitCode = [AtomicEndedSession]::ExitCode()
    $result.exitedAfterMs = ([AtomicEndedSession]::ExitedAt() - $sentAt) / 10000
  }
  $result.readyProcessExited = [AtomicEndedSession]::WatchedExited($params.readyProcessExitMs)
  $result.screen = [AtomicEndedSession]::Screen()
  [IO.File]::WriteAllText($ResultFile, ($result | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
} finally {
  [AtomicEndedSession]::EndLeftovers()
}
`;

/**
 * Windows only: run a program on a console of its own until it is ready and has its session-end window, then tell
 * that window that the session ends, as Windows does when the user signs out, and report how the program ended. The
 * program, and the process its ready file names, are ended through the helper's handles if they still run once the
 * wait is over or the helper fails.
 */
export async function runUntilSessionEnded(options: EndedSessionOptions): Promise<EndedSessionRun> {
	const script = join(options.directory, "end-session.ps1");
	const params = join(options.directory, "end-session.json");
	const result = join(options.directory, "end-session-result.json");
	writeFileSync(script, SESSION_END_SCRIPT);
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
	if (code !== 0) throw new Error(`the session-end helper failed with ${code}: ${stderr}`);
	return JSON.parse(readFileSync(result, "utf8")) as EndedSessionRun;
}
