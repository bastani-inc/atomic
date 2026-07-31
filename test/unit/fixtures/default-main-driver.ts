/**
 * Shared out-of-process driver for the default-main interactive host fixture.
 *
 * Spawns `default-main-interactive-host.ts`, decodes its `@@ATOMIC_TEST@@`
 * control reports, and exposes report waiters plus POSIX liveness helpers. Kept
 * separate so every interactive-engine end-to-end suite drives the same real
 * host/engine pair instead of re-implementing the transport.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bunExecutable, decodeStream, moduleDir, readStreamText, sleep, type SpawnedProcess, spawnProcess } from "../../helpers/runtime.js";

export const PREFIX = "@@ATOMIC_TEST@@";

export interface HarnessReport {
	type?: string;
	at?: number;
	recovering?: boolean;
	editorText?: string;
	streaming?: boolean;
	enginePid?: number;
	generation?: number;
	hostPid?: number;
	output?: string;
	sessionFile?: string;
	eventType?: string;
	message?: string;
	renders?: number;
	prefix?: string;
	items?: Array<{ value?: string; label?: string }> | null;
	/** Host UI ownership, reported on every heartbeat and state snapshot. */
	editorMounted?: boolean;
	focusIsEditor?: boolean;
	focusIsStaleInline?: boolean;
	blockingInlineDepth?: number;
	hasOverlay?: boolean;
}

export class DefaultMainDriver {
	readonly process: SpawnedProcess;
	readonly reports: HarnessReport[] = [];
	private readonly waiters = new Set<() => void>();
	private stderr = "";

	constructor(args: string[], env: Record<string, string>) {
		// Strip inherited engine-child markers: when this suite itself runs inside an
		// isolated Atomic engine session, ATOMIC_INTERACTIVE_ENGINE_CHILD=1 would leak
		// into the fixture and silently flip it into engine-child mode.
		const baseEnv: Record<string, string | undefined> = { ...process.env };
		for (const key of Object.keys(baseEnv)) {
			if (key.startsWith("ATOMIC_INTERACTIVE_ENGINE_")) delete baseEnv[key];
		}
		this.process = spawnProcess([
			bunExecutable(),
			join(moduleDir(import.meta.url), "default-main-interactive-host.ts"),
			...args,
		], {
			cwd: join(moduleDir(import.meta.url), "../../.."),
			env: { ...baseEnv, ...env },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		void this.readReports();
		void this.readStderr();
	}

	send(command: { type: "input" | "mutate" | "state" | "autocomplete"; data?: string }): void {
		const stdin = this.process.stdin;
		if (!stdin || typeof stdin === "number") throw new Error("fixture stdin is unavailable");
		stdin.write(`${JSON.stringify(command)}\n`);
		void stdin.flush();
	}

	async waitFor(predicate: (report: HarnessReport) => boolean, timeoutMs = 8_000): Promise<HarnessReport> {
		const existing = this.reports.find(predicate);
		if (existing) return existing;
		return new Promise<HarnessReport>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.waiters.delete(inspect);
				reject(new Error(`Timed out waiting for fixture report. events=${JSON.stringify(this.reports.filter((report) => report.type === "session_event" || report.type === "input_received").slice(-20))} last=${JSON.stringify(this.reports.slice(-5))} stderr=${this.stderr.slice(-4000)}`));
			}, timeoutMs);
			const inspect = (): void => {
				const found = this.reports.find(predicate);
				if (!found) return;
				clearTimeout(timeout);
				this.waiters.delete(inspect);
				resolve(found);
			};
			this.waiters.add(inspect);
		});
	}
	async waitForNext(fromIndex: number, predicate: (report: HarnessReport) => boolean, timeoutMs = 8_000): Promise<HarnessReport> {
		const scan = (): HarnessReport | undefined => {
			for (let index = fromIndex; index < this.reports.length; index += 1) {
				const report = this.reports[index]!;
				if (predicate(report)) return report;
			}
			return undefined;
		};
		const existing = scan();
		if (existing) return existing;
		return new Promise<HarnessReport>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.waiters.delete(inspect);
				reject(new Error(`Timed out waiting for fixture report. last=${JSON.stringify(this.reports.slice(-5))} stderr=${this.stderr.slice(-4000)}`));
			}, timeoutMs);
			const inspect = (): void => {
				const found = scan();
				if (!found) return;
				clearTimeout(timeout);
				this.waiters.delete(inspect);
				resolve(found);
			};
			this.waiters.add(inspect);
		});
	}


	async stop(): Promise<void> {
		if (this.process.exitCode === null) this.process.kill("SIGKILL");
		await this.process.exited;
	}

	private async readReports(): Promise<void> {
		const stdout = this.process.stdout;
		if (!stdout || typeof stdout === "number") return;
		const reader = decodeStream(stdout).getReader();
		let buffer = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += value;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const marker = line.indexOf(PREFIX);
				if (marker === -1) continue;
				try {
					this.reports.push(JSON.parse(line.slice(marker + PREFIX.length)) as HarnessReport);
					for (const waiter of this.waiters) waiter();
				} catch {}
			}
		}
	}

	private async readStderr(): Promise<void> {
		const stderr = this.process.stderr;
		if (!stderr || typeof stderr === "number") return;
		this.stderr = await readStreamText(stderr);
	}
}

export function isAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function waitForFile(path: string, timeoutMs = 5_000): Promise<number> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		try {
			const pid = Number(readFileSync(path, "utf8"));
			if (Number.isSafeInteger(pid) && pid > 0) return pid;
		} catch {}
		await sleep(10);
	}
	throw new Error(`Timed out waiting for ${path}`);
}

export async function waitForExit(pid: number, timeoutMs = 4_000): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (!isAlive(pid)) return;
		await sleep(20);
	}
	throw new Error(`PID ${pid} remained alive`);
}
