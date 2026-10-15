import { isAbsolute, join } from "node:path";
import { getBrokerLogPath, getBrokerPidPath } from "../../packages/intercom/broker/paths.js";
import { deserializeFixtureError, type FixtureError } from "./fixture-error.js";
import {
	bunExecutable,
	decodeStream,
	makeTempDirectory,
	moduleDir,
	readText,
	removeTempDirectory,
	type SpawnedProcess,
	sleep,
	spawnProcess,
	spawnSyncCollect,
} from "./runtime.js";

const REQUEST_TIMEOUT_MS = 30_000;
const BROKER_EXIT_TIMEOUT_MS = 10_000;

/** Windows redirects broker stderr from a cmd.exe parent that also owns the log handle. */
function brokerLauncherPid(pid: number, logPath: string): number | undefined {
	if (process.platform !== "win32") return undefined;
	const result = spawnSyncCollect(
		[
			"powershell.exe",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`$ErrorActionPreference = 'Stop';
$broker = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}";
if ($null -ne $broker) {
  $launcher = Get-CimInstance Win32_Process -Filter "ProcessId = $($broker.ParentProcessId)";
  if ($null -ne $launcher -and $launcher.Name -eq 'cmd.exe' -and $launcher.CommandLine.IndexOf($env:ATOMIC_FIXTURE_BROKER_LOG, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    Write-Output $launcher.ProcessId;
  }
}`,
		],
		{ env: { ...process.env, ATOMIC_FIXTURE_BROKER_LOG: logPath }, timeout: BROKER_EXIT_TIMEOUT_MS },
	);
	if (result.exitCode !== 0) throw new Error(`Cannot inspect fixture broker launcher: ${result.stderr.toString()}`);
	const text = result.stdout.toString().trim();
	if (text.length === 0) return undefined;
	const launcherPid = Number(text);
	if (!Number.isSafeInteger(launcherPid) || launcherPid <= 0) throw new Error("Invalid fixture broker launcher PID");
	return launcherPid;
}

function processExited(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
		throw error;
	}
}

export class WorkflowProcess {
	private readonly child: SpawnedProcess;
	private readonly pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
	private readonly output: Promise<void>;
	private readonly errors: Promise<string>;
	private sequence = 0;
	private transportError: Error | undefined;
	private exited = false;

	constructor(home: string, extra: Record<string, string>, fixture: string) {
		const path = isAbsolute(fixture) ? fixture : join(moduleDir(import.meta.url), "../fixtures", fixture);
		this.child = spawnProcess([bunExecutable(), path], {
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				ATOMIC_FAULT_TEST_HOME: home,
				ATOMIC_CODING_AGENT_DIR: join(home, ".atomic", "agent"),
				ATOMIC_WORKFLOW_JOURNAL_PATH: join(home, "journal.sqlite"),
				...extra,
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.child.stdin!.on("error", (error: Error) => this.fail(error));
		this.errors = new Response(this.child.stderr).text();
		this.output = this.drain();
	}

	private fail(error: Error): void {
		this.transportError ??= error;
		for (const request of this.pending.values()) request.reject(this.transportError);
	}

	private async drain(): Promise<void> {
		const reader = decodeStream(this.child.stdout!).getReader();
		let buffer = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += value;
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) break;
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (!line.startsWith('{"id":')) continue;
					const message = JSON.parse(line) as { id: number; result: never; error?: FixtureError | string };
					const request = this.pending.get(message.id);
					if (message.error) request?.reject(deserializeFixtureError(message.error));
					else request?.resolve(message.result);
				}
			}
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		} finally {
			reader.releaseLock();
			this.fail(new Error("Workflow fixture output closed"));
		}
	}

	async request<T = object>(command: string, value?: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
		if (this.transportError) throw this.transportError;
		const id = ++this.sequence;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await new Promise<T>((resolve, reject) => {
				this.pending.set(id, { resolve, reject });
				timer = setTimeout(() => reject(new Error(`Workflow fixture ${command} timed out`)), timeoutMs);
				this.child.stdin!.write(`${JSON.stringify({ id, command, sql: value })}\n`, (error) => {
					if (error) this.fail(error);
				});
			});
		} finally {
			clearTimeout(timer);
			this.pending.delete(id);
		}
	}

	async waitForExit(): Promise<void> {
		await Promise.all([this.child.exited, this.output, this.errors]);
		this.exited = true;
	}

	async crash(): Promise<void> {
		if (this.child.exitCode === null) this.child.kill("SIGKILL");
		await this.waitForExit();
	}

	async exit(): Promise<void> {
		if (this.exited) return;
		try {
			if (this.child.exitCode === null && this.transportError === undefined) await this.request("exit");
		} finally {
			if (this.child.exitCode === null) this.child.kill("SIGKILL");
			await this.waitForExit();
		}
	}
}

export class WorkflowProcessHome {
	readonly path = makeTempDirectory("atomic-workflow-process-");
	private readonly clients: WorkflowProcess[] = [];

	client(extra: Record<string, string>, fixture: string): WorkflowProcess {
		const client = new WorkflowProcess(this.path, extra, fixture);
		this.clients.push(client);
		return client;
	}

	async cleanup(): Promise<void> {
		const agentDir = join(this.path, ".atomic", "agent");
		const pidText = await readText(getBrokerPidPath(agentDir)).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		const pid = pidText === undefined ? undefined : Number(pidText);
		if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) throw new Error("Invalid fixture broker PID");
		// Capture the launcher before closing clients can let the broker retire.
		const launcherPid = pid === undefined ? undefined : brokerLauncherPid(pid, getBrokerLogPath(agentDir));
		const exits = await Promise.allSettled(this.clients.map((client) => client.exit()));
		if (pid !== undefined) {
			try {
				process.kill(pid, "SIGTERM");
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
			}
		}
		const processes = [pid, launcherPid].filter((candidate): candidate is number => candidate !== undefined);
		const deadline = Date.now() + BROKER_EXIT_TIMEOUT_MS;
		while (!processes.every(processExited)) {
			if (Date.now() >= deadline) throw new Error("Fixture broker or launcher did not exit before cleanup");
			await sleep(20);
		}
		removeTempDirectory(this.path);
		for (const exit of exits) {
			if (exit.status === "rejected") throw exit.reason;
		}
	}
}
