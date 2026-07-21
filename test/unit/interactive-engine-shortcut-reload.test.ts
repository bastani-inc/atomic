import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serialTest = process.platform === "win32" ? test.serial.skip : test.serial;
const PREFIX = "@@ATOMIC_TEST@@";

interface HarnessReport {
	type?: string;
	enginePid?: number;
	generation?: number;
	recovering?: boolean;
	message?: string;
	data?: string;
	shortcutHandled?: boolean;
	shortcutKeys?: string[];
	editorText?: string;
	expandKeys?: string[];
	expandDisplay?: string;
	toolsExpanded?: boolean;
}

class InteractiveModeDriver {
	readonly process: ReturnType<typeof Bun.spawn>;
	readonly reports: HarnessReport[] = [];
	private readonly waiters = new Set<() => void>();
	private stderr = "";

	constructor(args: string[], env: Record<string, string>) {
		const baseEnv: Record<string, string | undefined> = { ...process.env };
		for (const key of Object.keys(baseEnv)) {
			if (key.startsWith("ATOMIC_INTERACTIVE_ENGINE_")) delete baseEnv[key];
		}
		this.process = Bun.spawn([
			process.execPath,
			join(import.meta.dir, "fixtures", "default-main-interactive-host.ts"),
			...args,
		], {
			cwd: join(import.meta.dir, "../.."),
			env: { ...baseEnv, ...env },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		void this.readReports();
		void this.readStderr();
		void this.process.exited.then(() => {
			for (const waiter of this.waiters) waiter();
		});
	}

	async send(command: { type: "input" | "reload" | "shortcut" | "state"; data?: string }): Promise<void> {
		const stdin = this.process.stdin;
		if (!stdin || typeof stdin === "number") throw new Error("fixture stdin is unavailable");
		stdin.write(`${JSON.stringify(command)}\n`);
		await stdin.flush();
	}

	async waitForNext(
		fromIndex: number,
		predicate: (report: HarnessReport) => boolean,
		timeoutMs = 15_000,
		description = "fixture report",
	): Promise<HarnessReport> {
		const scan = (): HarnessReport | undefined => this.reports.slice(fromIndex).find(predicate);
		const existing = scan();
		if (existing) return existing;
		return new Promise((resolve, reject) => {
			const inspect = (): void => {
				const found = scan();
				if (found) {
					clearTimeout(timeout);
					this.waiters.delete(inspect);
					resolve(found);
					return;
				}
				if (this.process.exitCode === null) return;
				clearTimeout(timeout);
				this.waiters.delete(inspect);
				reject(new Error(`Fixture exited with code ${this.process.exitCode}; stderr=${this.stderr.slice(-4_000)}`));
			};
			const timeout = setTimeout(() => {
				this.waiters.delete(inspect);
				const nonHeartbeats = this.reports.filter((report) => report.type !== "heartbeat").slice(-30).map((report) => ({
					type: report.type, data: report.data, enginePid: report.enginePid, generation: report.generation,
					recovering: report.recovering, message: report.message, shortcutHandled: report.shortcutHandled,
					shortcutKeys: report.shortcutKeys, editorText: report.editorText, expandKeys: report.expandKeys,
					toolsExpanded: report.toolsExpanded,
				}));
				const lastHeartbeat = this.reports.findLast((report) => report.type === "heartbeat");
				reject(new Error(`Timed out waiting for ${description}; exitCode=${this.process.exitCode}; nonHeartbeats=${JSON.stringify(nonHeartbeats)}; lastHeartbeat=${JSON.stringify(lastHeartbeat)}; stderr=${this.stderr.slice(-4_000)}`));
			}, timeoutMs);
			this.waiters.add(inspect);
			inspect();
		});
	}
	waitFor(predicate: (report: HarnessReport) => boolean, timeoutMs = 15_000, description = "fixture report"): Promise<HarnessReport> {
		return this.waitForNext(0, predicate, timeoutMs, description);
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
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			buffer += value;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const marker = line.indexOf(PREFIX);
				if (marker === -1) continue;
				this.reports.push(JSON.parse(line.slice(marker + PREFIX.length)) as HarnessReport);
				for (const waiter of this.waiters) waiter();
			}
		}
	}

	private async readStderr(): Promise<void> {
		const stderr = this.process.stderr;
		if (stderr && typeof stderr !== "number") this.stderr = await new Response(stderr).text();
	}
}

function fixtureArgs(extension: string): string[] {
	return [
		"--no-session", "--no-extensions", "--extension", extension,
		"--no-skills", "--no-prompt-templates", "--no-themes", "--offline", "--approve",
		"--provider", "isolation-fixture", "--model", "blocking-model",
	];
}

function shortcutInvocations(path: string): string[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => line.split(":")[0]!);
}

async function dispatchInput(driver: InteractiveModeDriver, data: string): Promise<void> {
	const from = driver.reports.length;
	await driver.send({ type: "input", data });
	await driver.waitForNext(from, (report) => report.type === "input_handled" && report.data === data, 15_000, `input handled ${JSON.stringify(data)}`);
}

async function invokeShortcutWhenReady(driver: InteractiveModeDriver, data: string, timeoutMs = 15_000): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		const from = driver.reports.length;
		await driver.send({ type: "shortcut", data });
		const probe = await driver.waitForNext(from, (report) => report.type === "shortcut" && report.data === data, 15_000, "shortcut readiness probe");
		if (probe.shortcutHandled === true) return;
		await Bun.sleep(20);
	}
	assert.fail(`remote shortcut was not ready within ${timeoutMs}ms`);
}

// Polling the actual host shortcut dispatcher avoids racing the engine's initial
// keybinding publication. False probes have no side effect; the first true probe
// invokes the shortcut exactly once and becomes the synchronization barrier.

async function waitForShortcutInvocations(path: string, expected: string[], timeoutMs = 15_000): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		const actual = shortcutInvocations(path);
		if (actual.length >= expected.length) {
			assert.deepEqual(actual, expected);
			return;
		}
		await Bun.sleep(20);
	}
	assert.deepEqual(shortcutInvocations(path), expected, `shortcut dispatch did not settle within ${timeoutMs}ms`);
}

async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!existsSync(path) && performance.now() < deadline) await Bun.sleep(20);
	assert.equal(existsSync(path), true, `${path} was not created within ${timeoutMs}ms`);
}

async function waitForState(
	driver: InteractiveModeDriver,
	predicate: (report: HarnessReport) => boolean,
	timeoutMs = 20_000,
): Promise<HarnessReport> {
	const deadline = performance.now() + timeoutMs;
	let lastState: HarnessReport | undefined;
	while (performance.now() < deadline) {
		const from = driver.reports.length;
		await driver.send({ type: "state" });
		lastState = await driver.waitForNext(from, (report) => report.type === "state", 15_000, "state response");
		if (predicate(lastState)) return lastState;
		await Bun.sleep(20);
	}
	assert.fail(`fixture state did not converge within ${timeoutMs}ms; lastState=${JSON.stringify(lastState)}`);
}

async function reloadInteractiveMode(driver: InteractiveModeDriver, expectedBinding: string): Promise<void> {
	const from = driver.reports.length;
	await driver.send({ type: "reload" });
	await driver.waitForNext(from, (report) =>
		report.type === "reload_done" && report.expandKeys?.[0] === expectedBinding, 20_000);
}

async function reloadThroughExtensionContext(
	driver: InteractiveModeDriver,
	sessionStartFile: string,
	expectedBinding: string,
): Promise<void> {
	const from = driver.reports.length;
	await dispatchInput(driver, "/reload-keybindings-fixture");
	await driver.waitForNext(from, (report) =>
		report.type === "heartbeat" && report.editorText === "/reload-keybindings-fixture");
	await dispatchInput(driver, "\r");
	const deadline = performance.now() + 20_000;
	while (performance.now() < deadline) {
		const starts = existsSync(sessionStartFile) ? readFileSync(sessionStartFile, "utf8") : "";
		if (starts.includes(`reload:${expectedBinding}`)) {
			await waitForState(driver, (report) => report.expandKeys?.[0] === expectedBinding);
			return;
		}
		await Bun.sleep(20);
	}
	throw new Error(`Extension-context reload never committed ${expectedBinding}`);
}

serialTest("real isolated InteractiveMode refreshes remote shortcuts and preserves explicit agent-dir input/display parity", async () => {
	const temp = mkdtempSync(join(tmpdir(), "atomic-shortcut-reload-parity-"));
	const agentDir = join(temp, "custom-agent");
	const shortcutConfig = join(temp, "shortcut.txt");
	const shortcutLog = join(temp, "shortcut.log");
	const sessionStartFile = join(temp, "session-start.log");
	const keybindingsPath = join(agentDir, "keybindings.json");
	const extension = join(import.meta.dir, "fixtures", "blocking-tool-extension.ts");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(shortcutConfig, "ctrl+x,ctrl+y");
	writeFileSync(keybindingsPath, JSON.stringify({ "app.tools.expand": "ctrl+x" }));
	const driver = new InteractiveModeDriver(fixtureArgs(extension), {
		ATOMIC_CODING_AGENT_DIR: agentDir,
		ATOMIC_KEYBINDINGS_SHORTCUT_CONFIG_FILE: shortcutConfig,
		ATOMIC_KEYBINDINGS_SHORTCUT_LOG_FILE: shortcutLog,
		ATOMIC_KEYBINDINGS_RELOAD_COMMAND: "1",
		ATOMIC_KEYBINDINGS_SESSION_START_FILE: sessionStartFile,
	});
	try {
		await driver.waitFor((report) => report.type === "terminal_ready", 15_000, "terminal readiness");
		await driver.waitFor((report) => report.type === "heartbeat" && typeof report.enginePid === "number", 15_000, "engine PID readiness");
		let state = await waitForState(driver, (report) => report.expandKeys?.[0] === "ctrl+x");
		assert.equal(state.expandDisplay, "ctrl+x");
		const initiallyExpanded = state.toolsExpanded;
		await dispatchInput(driver, "\x18");
		assert.deepEqual(shortcutInvocations(shortcutLog), []);
		state = await waitForState(driver, (report) => report.toolsExpanded !== initiallyExpanded);
		assert.notEqual(state.toolsExpanded, initiallyExpanded, "custom agent-dir remap must reach editor input");
		await invokeShortcutWhenReady(driver, "\x19");
		await waitForShortcutInvocations(shortcutLog, ["ctrl+y"]);

		writeFileSync(keybindingsPath, JSON.stringify({ "app.tools.expand": "ctrl+y" }));
		await reloadThroughExtensionContext(driver, sessionStartFile, "ctrl+y");
		await dispatchInput(driver, "\x18");
		await waitForShortcutInvocations(shortcutLog, ["ctrl+y", "ctrl+x"]);
		await dispatchInput(driver, "\x19");

		writeFileSync(keybindingsPath, JSON.stringify({ "app.tools.expand": "ctrl+x" }));
		await reloadInteractiveMode(driver, "ctrl+x");
		await dispatchInput(driver, "\x18");
		await dispatchInput(driver, "\x19");
		await waitForShortcutInvocations(shortcutLog, ["ctrl+y", "ctrl+x", "ctrl+y"]);
	} finally {
		await driver.stop();
		rmSync(temp, { recursive: true, force: true });
	}
}, 60_000);

serialTest("real engine restart republishes bindings and replaces the remote shortcut catalog", async () => {
	const temp = mkdtempSync(join(tmpdir(), "atomic-shortcut-restart-parity-"));
	const agentDir = join(temp, "custom-agent");
	const shortcutConfig = join(temp, "shortcut.txt");
	const shortcutLog = join(temp, "shortcut.log");
	const toolPidFile = join(temp, "tool.pid");
	const keybindingsPath = join(agentDir, "keybindings.json");
	const extension = join(import.meta.dir, "fixtures", "blocking-tool-extension.ts");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(shortcutConfig, "ctrl+x,ctrl+y");
	writeFileSync(keybindingsPath, JSON.stringify({ "app.tools.expand": "ctrl+x" }));
	const driver = new InteractiveModeDriver(fixtureArgs(extension), {
		ATOMIC_BLOCKING_EXTENSION_INIT: "1",
		ATOMIC_BLOCKING_TOOL_PID_FILE: toolPidFile,
		ATOMIC_CODING_AGENT_DIR: agentDir,
		ATOMIC_KEYBINDINGS_SHORTCUT_CONFIG_FILE: shortcutConfig,
		ATOMIC_KEYBINDINGS_SHORTCUT_LOG_FILE: shortcutLog,
	});
	try {
		await driver.waitFor((report) => report.type === "terminal_ready");
		const initial = await driver.waitFor((report) => report.type === "heartbeat" && typeof report.enginePid === "number");
		const startup = await waitForState(driver, (report) => report.expandKeys?.[0] === "ctrl+x");
		assert.equal(startup.expandDisplay, "ctrl+x");
		await invokeShortcutWhenReady(driver, "\x19");
		await waitForShortcutInvocations(shortcutLog, ["ctrl+y"]);

		writeFileSync(keybindingsPath, JSON.stringify({ "app.tools.expand": "ctrl+y" }));
		writeFileSync(shortcutConfig, "ctrl+x");
		await dispatchInput(driver, "restart with new shortcuts");
		await driver.waitFor((report) => report.type === "heartbeat" && report.editorText === "restart with new shortcuts");
		await dispatchInput(driver, "\r");
		await waitForFile(toolPidFile);
		await dispatchInput(driver, "\u001b");
		const terminated = await driver.waitFor((report) =>
			report.type === "diagnostic" && report.message?.startsWith("Engine terminated;") === true, 15_000);
		assert.ok(terminated);
		const probeIndex = driver.reports.length;
		await driver.send({ type: "shortcut", data: "\x19" });
		const unavailableProbe = await driver.waitForNext(probeIndex, (report) => report.type === "shortcut" && report.data === "\x19");
		assert.equal(unavailableProbe.shortcutHandled, false, "generation replacement must invalidate stale shortcuts immediately");

		await driver.waitFor((report) =>
			report.type === "heartbeat" && typeof report.enginePid === "number" && report.enginePid !== initial.enginePid && report.recovering === false,
			20_000,
		);
		const restarted = await waitForState(driver, (report) => report.expandKeys?.[0] === "ctrl+y");
		assert.equal(restarted.expandDisplay, "ctrl+y");
		const expandedBefore = restarted.toolsExpanded;
		await dispatchInput(driver, "\x19");
		const updated = await waitForState(driver, (report) => report.toolsExpanded !== expandedBefore);
		assert.notEqual(updated.toolsExpanded, expandedBefore, "new binding must reach host input dispatch");
		assert.deepEqual(shortcutInvocations(shortcutLog), ["ctrl+y"], "stale remote key must not dispatch after restart");

		await dispatchInput(driver, "\x18");
		await waitForShortcutInvocations(shortcutLog, ["ctrl+y", "ctrl+x"]);
	} finally {
		await driver.stop();
		rmSync(temp, { recursive: true, force: true });
	}
}, 60_000);
