import assert, { AssertionError } from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const CONTROLLER_START_TIMEOUT_MS = 30_000;

export interface ProcessSuspender {
	suspend(pid: number): Promise<void>;
	resume(pid: number): Promise<void>;
	/** Whether the operating system reports the process stopped: every thread of it, on Windows. */
	isSuspended(pid: number): Promise<boolean>;
	close(): Promise<void>;
}

const CONTROLLER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Atomic -Name ProcessSuspension -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle);
[DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr handle);
'@
function Invoke-Operation([string]$operation, [uint32]$processId) {
  if ($operation -eq 'state') {
    $threads = @([Diagnostics.Process]::GetProcessById($processId).Threads)
    $suspended = @($threads | Where-Object { $_.ThreadState -eq 'Wait' -and $_.WaitReason -eq 'Suspended' })
    if ($threads.Count -gt 0 -and $suspended.Count -eq $threads.Count) { return 'suspended' }
    return 'active'
  }
  $handle = [Atomic.ProcessSuspension]::OpenProcess(0x0800, $false, $processId)
  if ($handle -eq [IntPtr]::Zero) {
    throw "OpenProcess failed for pid $processId (Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
  }
  try {
    if ($operation -eq 'suspend') { $status = [Atomic.ProcessSuspension]::NtSuspendProcess($handle) }
    elseif ($operation -eq 'resume') { $status = [Atomic.ProcessSuspension]::NtResumeProcess($handle) }
    else { throw "unknown operation $operation" }
    if ($status -ne 0) { throw "Nt$operation failed for pid $processId (NTSTATUS 0x$('{0:X8}' -f $status))" }
  } finally { [void][Atomic.ProcessSuspension]::CloseHandle($handle) }
}
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $parts = $line.Split(' ')
    [Console]::Out.WriteLine(('ok ' + (Invoke-Operation $parts[0] ([uint32]$parts[1]))).TrimEnd())
  } catch {
    [Console]::Out.WriteLine('error ' + ($_.Exception.Message -replace '[\\r\\n]+', ' '))
  }
}
`;

function assertPid(pid: number): void {
	assert.ok(Number.isSafeInteger(pid) && pid > 0, `Cannot suspend or resume invalid pid ${pid}`);
}

const posixSuspender: ProcessSuspender = {
	async suspend(pid) {
		assertPid(pid);
		process.kill(pid, "SIGSTOP");
	},
	async resume(pid) {
		assertPid(pid);
		process.kill(pid, "SIGCONT");
	},
	async isSuspended(pid) {
		assertPid(pid);
		const { stdout } = await promisify(execFile)("ps", ["-o", "stat=", "-p", String(pid)]);
		return stdout.trim().startsWith("T");
	},
	async close() {},
};

class WindowsProcessSuspender implements ProcessSuspender {
	private readonly replies: string[] = [];
	private waiter: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
	private failure: Error | undefined;
	private queue: Promise<unknown> = Promise.resolve();

	private constructor(private readonly controller: ChildProcessWithoutNullStreams) {
		createInterface({ input: controller.stdout }).on("line", (line) => {
			if (this.waiter) {
				const { resolve } = this.waiter;
				this.waiter = undefined;
				resolve(line);
			} else this.replies.push(line);
		});
		let stderr = "";
		controller.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 4_096) stderr += chunk.toString();
		});
		controller.once("error", (error) => this.fail(error));
		controller.once("close", (code) =>
			this.fail(
				new AssertionError({
					message: `Windows process-suspension controller exited with code ${code}: ${stderr.trim()}`,
				}),
			),
		);
	}

	static async start(): Promise<WindowsProcessSuspender> {
		const controller = spawn(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				Buffer.from(CONTROLLER_SCRIPT, "utf16le").toString("base64"),
			],
			{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
		);
		const suspender = new WindowsProcessSuspender(controller);
		const abort = new AbortController();
		try {
			const ready = await Promise.race([
				suspender.nextReply(),
				delay(CONTROLLER_START_TIMEOUT_MS, undefined, { signal: abort.signal }).then(() => {
					assert.fail(`Windows process-suspension controller not ready after ${CONTROLLER_START_TIMEOUT_MS}ms`);
				}),
			]);
			assert.equal(ready, "ready", "Windows process-suspension controller is ready");
			return suspender;
		} catch (error) {
			controller.kill();
			throw error;
		} finally {
			abort.abort();
		}
	}

	private fail(error: Error): void {
		this.failure ??= error;
		const waiter = this.waiter;
		this.waiter = undefined;
		waiter?.reject(this.failure);
	}

	private nextReply(): Promise<string> {
		const queued = this.replies.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		if (this.failure) return Promise.reject(this.failure);
		return new Promise((resolve, reject) => {
			this.waiter = { resolve, reject };
		});
	}

	private request(operation: "suspend" | "resume" | "state", pid: number): Promise<string> {
		assertPid(pid);
		const run = async () => {
			if (this.failure) throw this.failure;
			this.controller.stdin.write(`${operation} ${pid}\n`);
			const reply = await this.nextReply();
			const [status, ...result] = reply.split(" ");
			assert.equal(status, "ok", `Cannot ${operation} pid ${pid}: ${reply}`);
			return result.join(" ");
		};
		const result = this.queue.then(run, run);
		this.queue = result.catch(() => undefined);
		return result;
	}

	async suspend(pid: number): Promise<void> {
		await this.request("suspend", pid);
	}

	async resume(pid: number): Promise<void> {
		await this.request("resume", pid);
	}

	async isSuspended(pid: number): Promise<boolean> {
		return (await this.request("state", pid)) === "suspended";
	}

	async close(): Promise<void> {
		if (this.controller.exitCode !== null || this.controller.signalCode !== null) return;
		const closed = new Promise<void>((resolve) => this.controller.once("close", () => resolve()));
		this.controller.stdin.end();
		await closed;
	}
}

export async function createProcessSuspender(): Promise<ProcessSuspender> {
	return process.platform === "win32" ? WindowsProcessSuspender.start() : posixSuspender;
}
