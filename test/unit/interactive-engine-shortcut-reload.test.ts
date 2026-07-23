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
	streaming?: boolean;
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
	}

	send(command: { type: "input" | "reload" | "shortcut" | "state"; data?: string }): void {
		const stdin = this.process.stdin;
		if (!stdin || typeof stdin === "number") throw new Error("fixture stdin is unavailable");
		stdin.write(`${JSON.stringify(command)}\n`);
		void stdin.flush();
	}

	async waitForNext(
		fromIndex: number,
		predicate: (report: HarnessReport) => boolean,
		timeoutMs = 8_000,
		description = "fixture report",
	): Promise<HarnessReport> {
		const scan = (): HarnessReport | undefined => this.reports.slice(fromIndex).find(predicate);
		const existing = scan();
		if (existing) return existing;
		return new Promise((resolve, reject) => {
			const inspect = (): void => {
				const found = scan();
				if (!found) return;
				clearTimeout(timeout);
				this.waiters.delete(inspect);
				resolve(found);
			};
			const timeout = setTimeout(() => {
				this.waiters.delete(inspect);
				const observed = this.reports.slice(fromIndex);
				const observedTypes = [...new Set(observed.map((report) => report.type ?? "unknown"))];
				const diagnostics = observed
					.filter((report) => report.type === "diagnostic")
					.slice(-4)
					.map((report) => report.message);
				reject(new Error(
					`Timed out waiting for ${description}; observed=${observedTypes.join(",")}; diagnostics=${JSON.stringify(diagnostics)}; stderr=${this.stderr.slice(-4_000)}`,
				));
			}, timeoutMs);
			this.waiters.add(inspect);
		});
	}

	waitFor(
		predicate: (report: HarnessReport) => boolean,
		timeoutMs = 8_000,
		description = "fixture report",
	): Promise<HarnessReport> {
		return this.waitForNext(0, predicate, timeoutMs, description);
	}

	async waitUntilShortcutReady(shortcut: string, fromIndex = 0): Promise<HarnessReport> {
		return Promise.race([
			this.waitForNext(
				fromIndex,
				(report) => report.type === "keybinding_state" && report.shortcutKeys?.includes(shortcut) === true,
				8_000,
				`${shortcut} shortcut readiness`,
			),
			this.process.exited.then((exitCode) => {
				throw new Error(`Fixture exited before ${shortcut} became ready (exit=${exitCode}); stderr=${this.stderr.slice(-4_000)}`);
			}),
		]);
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

async function reloadInteractiveMode(driver: InteractiveModeDriver, expectedBinding: string): Promise<void> {
	const from = driver.reports.length;
	driver.send({ type: "reload" });
	await driver.waitForNext(from, (report) =>
		report.type === "reload_done" && report.expandKeys?.[0] === expectedBinding, 12_000);
}

async function reloadThroughExtensionContext(
	driver: InteractiveModeDriver,
	sessionStartFile: string,
	expectedBinding: string,
): Promise<void> {
	const from = driver.reports.length;
	driver.send({ type: "input", data: "/reload-keybindings-fixture" });
	await driver.waitForNext(from, (report) =>
		report.type === "heartbeat" && report.editorText === "/reload-keybindings-fixture");
	driver.send({ type: "input", data: "\r" });
	const deadline = performance.now() + 12_000;
	while (performance.now() < deadline) {
		const starts = existsSync(sessionStartFile) ? readFileSync(sessionStartFile, "utf8") : "";
		if (starts.includes(`reload:${expectedBinding}`)) {
			await driver.waitForNext(
				from,
				(report) => report.type === "keybinding_state" && report.expandKeys?.[0] === expectedBinding,
				8_000,
				`committed ${expectedBinding} keybinding state`,
			);
			const stateIndex = driver.reports.length;
			driver.send({ type: "state" });
			await driver.waitForNext(
				stateIndex,
				(report) => report.type === "state" && report.expandKeys?.[0] === expectedBinding,
				8_000,
				`host ${expectedBinding} keybinding state`,
			);
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
		await driver.waitFor((report) => report.type === "terminal_ready");
		await driver.waitFor((report) => report.type === "heartbeat" && typeof report.enginePid === "number");
		driver.send({ type: "state" });
		let state = await driver.waitFor((report) => report.type === "state" && report.expandKeys?.[0] === "ctrl+x");
		assert.equal(state.expandDisplay, "ctrl+x");
		const initiallyExpanded = state.toolsExpanded;
		driver.send({ type: "input", data: "\x18" });
		await Bun.sleep(50);
		assert.deepEqual(shortcutInvocations(shortcutLog), []);
		const stateIndex = driver.reports.length;
		driver.send({ type: "state" });
		state = await driver.waitForNext(stateIndex, (report) => report.type === "state");
		assert.notEqual(state.toolsExpanded, initiallyExpanded, "custom agent-dir remap must reach editor input");
		await driver.waitUntilShortcutReady("ctrl+y");
		driver.send({ type: "input", data: "\x19" });
		const startupDeadline = performance.now() + 3_000;
		while (shortcutInvocations(shortcutLog).length === 0 && performance.now() < startupDeadline) await Bun.sleep(20);
		assert.deepEqual(shortcutInvocations(shortcutLog), ["ctrl+y"]);

		writeFileSync(keybindingsPath, JSON.stringify({ "app.tools.expand": "ctrl+y" }));
		await reloadThroughExtensionContext(driver, sessionStartFile, "ctrl+y");
		driver.send({ type: "input", data: "\x18" });
		const firstDeadline = performance.now() + 3_000;
		while (shortcutInvocations(shortcutLog).length < 2 && performance.now() < firstDeadline) await Bun.sleep(20);
		assert.deepEqual(shortcutInvocations(shortcutLog), ["ctrl+y", "ctrl+x"]);
		driver.send({ type: "input", data: "\x19" });
		await Bun.sleep(50);
		assert.deepEqual(shortcutInvocations(shortcutLog), ["ctrl+y", "ctrl+x"], "reserved callback must be removed");

		writeFileSync(keybindingsPath, JSON.stringify({ "app.tools.expand": "ctrl+x" }));
		await reloadInteractiveMode(driver, "ctrl+x");
		driver.send({ type: "input", data: "\x18" });
		await Bun.sleep(50);
		assert.deepEqual(shortcutInvocations(shortcutLog), ["ctrl+y", "ctrl+x"], "stale callback must not survive");
		driver.send({ type: "input", data: "\x19" });
		const secondDeadline = performance.now() + 3_000;
		while (shortcutInvocations(shortcutLog).length < 3 && performance.now() < secondDeadline) await Bun.sleep(20);
		assert.deepEqual(shortcutInvocations(shortcutLog), ["ctrl+y", "ctrl+x", "ctrl+y"]);
	} finally {
		await driver.stop();
		rmSync(temp, { recursive: true, force: true });
	}
}, 30_000);

serialTest("startup shortcut dispatch waits for extension binding", async () => {
	const temp = mkdtempSync(join(tmpdir(), "atomic-shortcut-gated-bind-"));
	const agentDir = join(temp, "custom-agent");
	const shortcutConfig = join(temp, "shortcut.txt");
	const shortcutLog = join(temp, "shortcut.log");
	const startupGate = join(temp, "session-start.gate");
	const keybindingsPath = join(agentDir, "keybindings.json");
	const extension = join(import.meta.dir, "fixtures", "blocking-tool-extension.ts");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(shortcutConfig, "ctrl+y");
	writeFileSync(keybindingsPath, JSON.stringify({ "app.tools.expand": "ctrl+x" }));
	const driver = new InteractiveModeDriver(fixtureArgs(extension), {
		ATOMIC_CODING_AGENT_DIR: agentDir,
		ATOMIC_KEYBINDINGS_SHORTCUT_CONFIG_FILE: shortcutConfig,
		ATOMIC_KEYBINDINGS_SHORTCUT_LOG_FILE: shortcutLog,
		ATOMIC_KEYBINDINGS_SESSION_START_GATE_FILE: startupGate,
	});
	try {
		await driver.waitFor((report) => report.type === "terminal_ready");
		await driver.waitFor((report) => report.type === "heartbeat" && typeof report.enginePid === "number");
		while (!existsSync(startupGate)) await Bun.sleep(10);
		assert.equal(
			driver.reports.some((report) => report.type === "keybinding_state" && report.shortcutKeys?.includes("ctrl+y") === true),
			false,
			"remote shortcut must remain unavailable while extension binding is gated",
		);
		const readinessIndex = driver.reports.length;
		writeFileSync(`${startupGate}.release`, "release");
		await driver.waitUntilShortcutReady("ctrl+y", readinessIndex);
		driver.send({ type: "input", data: "\x19" });
		const dispatchDeadline = performance.now() + 3_000;
		while (shortcutInvocations(shortcutLog).length === 0 && performance.now() < dispatchDeadline) await Bun.sleep(20);
		assert.deepEqual(shortcutInvocations(shortcutLog), ["ctrl+y"]);
	} finally {
		await driver.stop();
		rmSync(temp, { recursive: true, force: true });
	}
}, 12_000);

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
		driver.send({ type: "state" });
		const startup = await driver.waitFor((report) => report.type === "state" && report.expandKeys?.[0] === "ctrl+x");
		assert.equal(startup.expandDisplay, "ctrl+x");
		await driver.waitUntilShortcutReady("ctrl+y");
		driver.send({ type: "input", data: "\x19" });
		const initialShortcutDeadline = performance.now() + 3_000;
		while (shortcutInvocations(shortcutLog).length === 0 && performance.now() < initialShortcutDeadline) await Bun.sleep(20);
		assert.deepEqual(shortcutInvocations(shortcutLog), ["ctrl+y"]);

		writeFileSync(keybindingsPath, JSON.stringify({ "app.tools.expand": "ctrl+y" }));
		writeFileSync(shortcutConfig, "ctrl+x");
		driver.send({ type: "input", data: "restart with new shortcuts" });
		await driver.waitFor((report) => report.type === "heartbeat" && report.editorText === "restart with new shortcuts");
		driver.send({ type: "input", data: "\r" });
		while (!existsSync(toolPidFile)) await Bun.sleep(10);
		const interruptReadyIndex = driver.reports.length;
		await driver.waitForNext(
			interruptReadyIndex,
			(report) => report.type === "heartbeat" && report.streaming === true,
			8_000,
			"host streaming interrupt readiness",
		);
		driver.send({ type: "input", data: "\u001b" });
		const terminated = await driver.waitFor((report) =>
			report.type === "diagnostic" && report.message?.startsWith("Engine terminated;") === true,
			8_000,
			"engine termination diagnostic",
		);
		assert.ok(terminated);
		const probeIndex = driver.reports.length;
		driver.send({ type: "shortcut", data: "\x19" });
		const unavailableProbe = await driver.waitForNext(probeIndex, (report) => report.type === "shortcut" && report.data === "\x19");
		assert.equal(unavailableProbe.shortcutHandled, false, "generation replacement must invalidate stale shortcuts immediately");

		await driver.waitFor((report) =>
			report.type === "heartbeat" && typeof report.enginePid === "number" && report.enginePid !== initial.enginePid && report.recovering === false,
			12_000,
		);
		const stateIndex = driver.reports.length;
		driver.send({ type: "state" });
		const restarted = await driver.waitForNext(stateIndex, (report) => report.type === "state" && report.expandKeys?.[0] === "ctrl+y");
		assert.equal(restarted.expandDisplay, "ctrl+y");
		const expandedBefore = restarted.toolsExpanded;
		driver.send({ type: "input", data: "\x19" });
		const updatedStateIndex = driver.reports.length;
		driver.send({ type: "state" });
		const updated = await driver.waitForNext(updatedStateIndex, (report) => report.type === "state");
		assert.notEqual(updated.toolsExpanded, expandedBefore, "new binding must reach host input dispatch");
		assert.deepEqual(shortcutInvocations(shortcutLog), ["ctrl+y"], "stale remote key must not dispatch after restart");

		driver.send({ type: "input", data: "\x18" });
		const restartedShortcutDeadline = performance.now() + 3_000;
		while (shortcutInvocations(shortcutLog).length < 2 && performance.now() < restartedShortcutDeadline) await Bun.sleep(20);
		assert.deepEqual(shortcutInvocations(shortcutLog), ["ctrl+y", "ctrl+x"]);
	} finally {
		await driver.stop();
		rmSync(temp, { recursive: true, force: true });
	}
}, 30_000);
