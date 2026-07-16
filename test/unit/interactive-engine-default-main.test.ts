import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface HarnessReport {
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
}

const PREFIX = "@@ATOMIC_TEST@@";

class DefaultMainDriver {
	readonly process: ReturnType<typeof Bun.spawn>;
	readonly reports: HarnessReport[] = [];
	private readonly waiters = new Set<() => void>();
	private stderr = "";

	constructor(args: string[], env: Record<string, string>) {
		this.process = Bun.spawn([
			process.execPath,
			join(import.meta.dir, "fixtures", "default-main-interactive-host.ts"),
			...args,
		], {
			cwd: join(import.meta.dir, "../.."),
			env: { ...process.env, ...env },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		void this.readReports();
		void this.readStderr();
	}

	send(command: { type: "input" | "mutate" | "state"; data?: string }): void {
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

	async stop(): Promise<void> {
		if (this.process.exitCode === null) this.process.kill("SIGKILL");
		await this.process.exited;
	}

	private async readReports(): Promise<void> {
		const stdout = this.process.stdout;
		if (!stdout || typeof stdout === "number") return;
		const reader = stdout.pipeThrough(new TextDecoderStream()).getReader();
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
		this.stderr = await new Response(stderr).text();
	}
}

function isAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<number> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		try { return Number(readFileSync(path, "utf8")); } catch {}
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${path}`);
}

async function waitForExit(pid: number, timeoutMs = 4_000): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (!isAlive(pid)) return;
		await Bun.sleep(20);
	}
	throw new Error(`PID ${pid} remained alive`);
}

function maximumGap(values: readonly number[]): number {
	let maximum = 0;
	for (let index = 1; index < values.length; index += 1) maximum = Math.max(maximum, values[index]! - values[index - 1]!);
	return maximum;
}

function fixtureArgs(extension: string): string[] {
	return [
		"--no-session", "--no-extensions", "--extension", extension,
		"--no-skills", "--no-prompt-templates", "--no-themes", "--offline",
		"--provider", "isolation-fixture", "--model", "blocking-model",
	];
}
function settingsEntryCounts(path: string): Record<"model_change" | "session_info" | "thinking_level_change", number> {
	const counts = { model_change: 0, session_info: 0, thinking_level_change: 0 };
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line) continue;
		const entry = JSON.parse(line) as { type?: string };
		if (entry.type === "model_change" || entry.type === "session_info" || entry.type === "thinking_level_change") counts[entry.type] += 1;
	}
	return counts;
}


test.serial("default main InteractiveMode survives Escape, restarts, and kills the full blocked process tree", async () => {
	const temp = mkdtempSync(join(tmpdir(), "atomic-default-main-"));
	const toolPidFile = join(temp, "tool.pid");
	const grandchildPidFile = join(temp, "grandchild.pid");
	const driver = new DefaultMainDriver(fixtureArgs(join(import.meta.dir, "fixtures", "blocking-tool-extension.ts")), {
		ATOMIC_BLOCKING_TOOL_PID_FILE: toolPidFile,
		ATOMIC_BLOCKING_GRANDCHILD_PID_FILE: grandchildPidFile,
		ATOMIC_CONFIG_DIR: join(temp, "config"),
	});
	try {
		await driver.waitFor((report) => report.type === "terminal_ready");
		const initial = await driver.waitFor((report) => report.type === "heartbeat" && typeof report.enginePid === "number");
		driver.send({ type: "input", data: "run the blocking tool" });
		await driver.waitFor((report) => report.type === "heartbeat" && report.editorText === "run the blocking tool");
		driver.send({ type: "input", data: "\r" });
		const toolPid = await waitForFile(toolPidFile);
		const grandchildPid = await waitForFile(grandchildPidFile);
		assert.equal(toolPid, initial.enginePid);
		assert.ok(isAlive(grandchildPid));
		await driver.waitFor((report) => report.type === "render" && report.output?.includes("tool.execute busy_loop") === true);
		const beforeEscapeReports = driver.reports.length;
		driver.send({ type: "input", data: "\u001b" });
		await driver.waitFor((report) => report.type === "diagnostic" && report.message?.includes("result unknown; inspect side effects before retrying") === true);
		const restarted = await driver.waitFor((report) =>
			report.type === "heartbeat" && typeof report.enginePid === "number" && report.enginePid !== toolPid && report.recovering === false,
			10_000,
		);
		assert.notEqual(restarted.enginePid, toolPid);
		await waitForExit(toolPid);
		await waitForExit(grandchildPid);
		driver.send({ type: "input", data: "prove recovery" });
		const usable = await driver.waitFor((report) => report.type === "heartbeat" && report.editorText === "prove recovery");
		assert.equal(usable.editorText, "prove recovery");
		const heartbeats = driver.reports.slice(beforeEscapeReports)
			.filter((report): report is HarnessReport & { at: number } => report.type === "heartbeat" && typeof report.at === "number")
			.map((report) => report.at);
		assert.ok(heartbeats.length > 20, "host heartbeat did not remain active through cancellation and restart");
		assert.ok(maximumGap(heartbeats) <= 100, `host heartbeat gap was ${maximumGap(heartbeats).toFixed(1)} ms`);
	} finally {
		await driver.stop();
		rmSync(temp, { recursive: true, force: true });
	}
}, 20_000);

test.serial("forced default-main host death leaves no engine or detached grandchild", async () => {
	if (process.platform === "win32") return;
	const temp = mkdtempSync(join(tmpdir(), "atomic-host-death-"));
	const toolPidFile = join(temp, "tool.pid");
	const grandchildPidFile = join(temp, "grandchild.pid");
	const driver = new DefaultMainDriver(fixtureArgs(join(import.meta.dir, "fixtures", "blocking-tool-extension.ts")), {
		ATOMIC_BLOCKING_TOOL_PID_FILE: toolPidFile,
		ATOMIC_BLOCKING_GRANDCHILD_PID_FILE: grandchildPidFile,
		ATOMIC_CONFIG_DIR: join(temp, "config"),
	});
	try {
		await driver.waitFor((report) => report.type === "terminal_ready");
		driver.send({ type: "input", data: "run the blocking tool" });
		driver.send({ type: "input", data: "\r" });
		const enginePid = await waitForFile(toolPidFile);
		const grandchildPid = await waitForFile(grandchildPidFile);
		driver.process.kill("SIGKILL");
		await driver.process.exited;
		await waitForExit(enginePid);
		await waitForExit(grandchildPid);
	} finally {
		await driver.stop();
		rmSync(temp, { recursive: true, force: true });
	}
}, 20_000);

test.serial("default InteractiveMode host mutations persist exactly once in the engine", async () => {
	const temp = mkdtempSync(join(tmpdir(), "atomic-exact-once-"));
	const extension = join(import.meta.dir, "fixtures", "blocking-tool-extension.ts");
	const args = fixtureArgs(extension).filter((value) => value !== "--no-session");
	args.push("--session-dir", join(temp, "sessions"));
	const toolPidFile = join(temp, "tool.pid");
	const driver = new DefaultMainDriver(args, {
		ATOMIC_CONFIG_DIR: join(temp, "config"),
		ATOMIC_BLOCKING_TOOL_PID_FILE: toolPidFile,
		ATOMIC_NONBLOCKING_TOOL: "1",
	});
	try {
		await driver.waitFor((report) => report.type === "terminal_ready");
		await driver.waitFor((report) => report.type === "heartbeat" && typeof report.enginePid === "number");
		driver.send({ type: "input", data: "create persisted session" });
		await driver.waitFor((report) => report.type === "heartbeat" && report.editorText === "create persisted session");
		driver.send({ type: "input", data: "\r" });
		await driver.waitFor((report) => report.type === "session_event" && report.eventType === "agent_end");
		driver.send({ type: "state" });
		const state = await driver.waitFor((report) => report.type === "state" && typeof report.sessionFile === "string");
		const before = settingsEntryCounts(state.sessionFile!);
		driver.send({ type: "mutate" });
		const done = await driver.waitFor((report) => report.type === "mutation_done" && report.sessionFile === state.sessionFile);
		assert.equal(done.sessionFile, state.sessionFile);
		const after = settingsEntryCounts(state.sessionFile!);
		assert.equal(after.model_change - before.model_change, 1);
		assert.equal(after.thinking_level_change - before.thinking_level_change, 1);
		assert.equal(after.session_info - before.session_info, 1);
	} finally {
		await driver.stop();
		rmSync(temp, { recursive: true, force: true });
	}
}, 20_000);

test.serial("default InteractiveMode preserves child-owned custom renderers and factory widgets", async () => {
	const temp = mkdtempSync(join(tmpdir(), "atomic-render-parity-"));
	const rendererPidFile = join(temp, "renderer.pid");
	const widgetPidFile = join(temp, "widget.pid");
	const toolPidFile = join(temp, "tool.pid");
	const toolRendererPidFile = join(temp, "tool-renderer.pid");
	const extension = join(import.meta.dir, "fixtures", "blocking-tool-extension.ts");
	const driver = new DefaultMainDriver(fixtureArgs(extension), {
		ATOMIC_RENDERER_FIXTURE: "1",
		ATOMIC_RENDERER_PID_FILE: rendererPidFile,
		ATOMIC_WIDGET_PID_FILE: widgetPidFile,
		ATOMIC_CONFIG_DIR: join(temp, "config"),
		ATOMIC_BLOCKING_TOOL_PID_FILE: toolPidFile,
		ATOMIC_TOOL_RENDERER_PID_FILE: toolRendererPidFile,
		ATOMIC_NONBLOCKING_TOOL: "1",
	});
	try {
		const ready = await driver.waitFor((report) => report.type === "terminal_ready");
		await driver.waitFor((report) => report.type === "render" && report.output?.includes("factory widget parity") === true);
		await driver.waitFor((report) => report.type === "render" && report.output?.includes("custom renderer parity") === true);
		assert.notEqual(await waitForFile(widgetPidFile), ready.hostPid);
		assert.notEqual(await waitForFile(rendererPidFile), ready.hostPid);
		driver.send({ type: "input", data: "render the tool" });
		await driver.waitFor((report) => report.type === "heartbeat" && report.editorText === "render the tool");
		driver.send({ type: "input", data: "\r" });
		await driver.waitFor((report) => report.type === "render" && report.output?.includes("child tool renderer:busy-call") === true);
		assert.equal(await waitForFile(toolRendererPidFile), await waitForFile(toolPidFile));
	} finally {
		await driver.stop();
		rmSync(temp, { recursive: true, force: true });
	}
}, 20_000);
