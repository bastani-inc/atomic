import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
	bunExecutable,
	decodeStream,
	moduleDir,
	readStreamText,
	type SpawnedProcess,
	sleep,
	spawnProcess,
} from "../helpers/runtime.js";

const serialTest = process.platform === "win32" ? test.sequential.skip : test.sequential;
const PREFIX = "@@ATOMIC_TEST@@";
const ENGINE_BIND_SCENARIO_TIMEOUT_MS = 30_000;
const ENGINE_REPORT_TIMEOUT_MS = 30_000;

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
	readonly process: SpawnedProcess;
	readonly reports: HarnessReport[] = [];
	private readonly waiters = new Set<() => void>();
	private stderr = "";

	constructor(args: string[], env: Record<string, string>) {
		const baseEnv: Record<string, string | undefined> = { ...process.env };
		for (const key of Object.keys(baseEnv)) {
			if (key.startsWith("ATOMIC_INTERACTIVE_ENGINE_")) delete baseEnv[key];
		}
		this.process = spawnProcess(
			[bunExecutable(), join(moduleDir(import.meta.url), "fixtures", "default-main-interactive-host.ts"), ...args],
			{
				cwd: join(moduleDir(import.meta.url), "../.."),
				env: { ...baseEnv, ...env },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
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
		timeoutMs = ENGINE_REPORT_TIMEOUT_MS,
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
				reject(
					new Error(
						`Timed out waiting for ${description}; observed=${observedTypes.join(",")}; diagnostics=${JSON.stringify(diagnostics)}; stderr=${this.stderr.slice(-4_000)}`,
					),
				);
			}, timeoutMs);
			this.waiters.add(inspect);
		});
	}

	waitFor(
		predicate: (report: HarnessReport) => boolean,
		timeoutMs = ENGINE_REPORT_TIMEOUT_MS,
		description = "fixture report",
	): Promise<HarnessReport> {
		return this.waitForNext(0, predicate, timeoutMs, description);
	}

	async waitUntilShortcutReady(shortcut: string, fromIndex = 0): Promise<HarnessReport> {
		return Promise.race([
			this.waitForNext(
				fromIndex,
				(report) => report.type === "keybinding_state" && report.shortcutKeys?.includes(shortcut) === true,
				ENGINE_REPORT_TIMEOUT_MS,
				`${shortcut} shortcut readiness`,
			),
			this.process.exited.then((exitCode) => {
				throw new Error(
					`Fixture exited before ${shortcut} became ready (exit=${exitCode}); stderr=${this.stderr.slice(-4_000)}`,
				);
			}),
		]);
	}
	async waitUntilEngineBound(shortcut: string): Promise<HarnessReport> {
		const bound = await Promise.race([
			this.waitFor((report) => report.type === "engine_bound", ENGINE_BIND_SCENARIO_TIMEOUT_MS),
			this.process.exited.then((exitCode) => {
				throw new Error(
					`Fixture exited before engine binding completed (exit=${exitCode}); stderr=${this.stderr.slice(-4_000)}`,
				);
			}),
		]);
		const catalog = [...this.reports].reverse().find((report) => report.type === "keybinding_state");
		if (catalog?.shortcutKeys?.includes(shortcut) !== true) {
			throw new Error(`Engine bound without expected shortcut ${shortcut}`);
		}
		return bound;
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
		if (stderr && typeof stderr !== "number") this.stderr = await readStreamText(stderr);
	}
}

function fixtureArgs(extension: string): string[] {
	return [
		"--no-session",
		"--no-extensions",
		"--extension",
		extension,
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--offline",
		"--approve",
		"--provider",
		"isolation-fixture",
		"--model",
		"blocking-model",
	];
}

function shortcutInvocations(path: string): string[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split(":")[0]!);
}

async function reloadInteractiveMode(driver: InteractiveModeDriver, expectedBinding: string): Promise<void> {
	const from = driver.reports.length;
	driver.send({ type: "reload" });
	await driver.waitForNext(
		from,
		(report) => report.type === "reload_done" && report.expandKeys?.[0] === expectedBinding,
		12_000,
	);
}

async function reloadThroughExtensionContext(
	driver: InteractiveModeDriver,
	sessionStartFile: string,
	expectedBinding: string,
): Promise<void> {
	const from = driver.reports.length;
	driver.send({ type: "input", data: "/reload-keybindings-fixture" });
	await driver.waitForNext(
		from,
		(report) => report.type === "heartbeat" && report.editorText === "/reload-keybindings-fixture",
	);
	driver.send({ type: "input", data: "\r" });
	const deadline = performance.now() + 12_000;
	while (performance.now() < deadline) {
		const starts = existsSync(sessionStartFile) ? readFileSync(sessionStartFile, "utf8") : "";
		if (starts.includes(`reload:${expectedBinding}`)) {
			await driver.waitForNext(
				from,
				(report) => report.type === "keybinding_state" && report.expandKeys?.[0] === expectedBinding,
				ENGINE_REPORT_TIMEOUT_MS,
				`committed ${expectedBinding} keybinding state`,
			);
			const stateIndex = driver.reports.length;
			driver.send({ type: "state" });
			await driver.waitForNext(
				stateIndex,
				(report) => report.type === "state" && report.expandKeys?.[0] === expectedBinding,
				ENGINE_REPORT_TIMEOUT_MS,
				`host ${expectedBinding} keybinding state`,
			);
			return;
		}
		await sleep(20);
	}
	throw new Error(`Extension-context reload never committed ${expectedBinding}`);
}

serialTest(
	"real isolated InteractiveMode refreshes remote shortcuts and preserves explicit agent-dir input/display parity",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-shortcut-reload-parity-"));
		const agentDir = join(temp, "custom-agent");
		const shortcutConfig = join(temp, "shortcut.txt");
		const shortcutLog = join(temp, "shortcut.log");
		const sessionStartFile = join(temp, "session-start.log");
		const keybindingsPath = join(agentDir, "keybindings.json");
		const extension = join(moduleDir(import.meta.url), "fixtures", "blocking-tool-extension.ts");
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
			await sleep(50);
			assert.deepEqual(shortcutInvocations(shortcutLog), []);
			const stateIndex = driver.reports.length;
			driver.send({ type: "state" });
			state = await driver.waitForNext(stateIndex, (report) => report.type === "state");
			assert.notEqual(state.toolsExpanded, initiallyExpanded, "custom agent-dir remap must reach editor input");
			await driver.waitUntilEngineBound("ctrl+y");
			driver.send({ type: "input", data: "\x19" });
			const startupDeadline = performance.now() + 3_000;
			while (shortcutInvocations(shortcutLog).length === 0 && performance.now() < startupDeadline) await sleep(20);
			assert.deepEqual(shortcutInvocations(shortcutLog), ["ctrl+y"]);

			writeFileSync(keybindingsPath, JSON.stringify({ "app.tools.expand": "ctrl+y" }));
			await reloadThroughExtensionContext(driver, sessionStartFile, "ctrl+y");
			driver.send({ type: "input", data: "\x18" });
			const firstDeadline = performance.now() + 3_000;
			while (shortcutInvocations(shortcutLog).length < 2 && performance.now() < firstDeadline) await sleep(20);
			assert.deepEqual(shortcutInvocations(shortcutLog), ["ctrl+y", "ctrl+x"]);
			driver.send({ type: "input", data: "\x19" });
			await sleep(50);
			assert.deepEqual(shortcutInvocations(shortcutLog), ["ctrl+y", "ctrl+x"], "reserved callback must be removed");

			writeFileSync(keybindingsPath, JSON.stringify({ "app.tools.expand": "ctrl+x" }));
			await reloadInteractiveMode(driver, "ctrl+x");
			driver.send({ type: "input", data: "\x18" });
			await sleep(50);
			assert.deepEqual(shortcutInvocations(shortcutLog), ["ctrl+y", "ctrl+x"], "stale callback must not survive");
			driver.send({ type: "input", data: "\x19" });
			const secondDeadline = performance.now() + 3_000;
			while (shortcutInvocations(shortcutLog).length < 3 && performance.now() < secondDeadline) await sleep(20);
			assert.deepEqual(shortcutInvocations(shortcutLog), ["ctrl+y", "ctrl+x", "ctrl+y"]);
		} finally {
			await driver.stop();
			rmSync(temp, { recursive: true, force: true });
		}
	},
	30_000,
);

serialTest(
	"startup shortcut dispatch waits for extension binding",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-shortcut-gated-bind-"));
		const agentDir = join(temp, "custom-agent");
		const shortcutConfig = join(temp, "shortcut.txt");
		const shortcutLog = join(temp, "shortcut.log");
		const startupGate = join(temp, "session-start.gate");
		const keybindingsPath = join(agentDir, "keybindings.json");
		const extension = join(moduleDir(import.meta.url), "fixtures", "blocking-tool-extension.ts");
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
			while (!existsSync(startupGate)) await sleep(10);
			assert.equal(
				driver.reports.some(
					(report) => report.type === "keybinding_state" && report.shortcutKeys?.includes("ctrl+y") === true,
				),
				false,
				"remote shortcut must remain unavailable while extension binding is gated",
			);
			const readinessIndex = driver.reports.length;
			writeFileSync(`${startupGate}.release`, "release");
			await driver.waitUntilShortcutReady("ctrl+y", readinessIndex);
			driver.send({ type: "input", data: "\x19" });
			const dispatchDeadline = performance.now() + 3_000;
			while (shortcutInvocations(shortcutLog).length === 0 && performance.now() < dispatchDeadline) await sleep(20);
			assert.deepEqual(shortcutInvocations(shortcutLog), ["ctrl+y"]);
		} finally {
			await driver.stop();
			rmSync(temp, { recursive: true, force: true });
		}
	},
	12_000,
);

// This scenario deliberately delays extension session startup by 9 s, so its
// floor is ~9.7 s of unavoidable waiting. It inherits the shared 30 s suite
// default rather than carrying an explicit budget: the former explicit 20 s was
// below that default and left the duration-headroom guard permanently warning
// on a cost the fixture chose on purpose.
serialTest("post-bind shortcut readiness survives delayed extension session startup", async () => {
	const temp = mkdtempSync(join(tmpdir(), "atomic-shortcut-delayed-bind-"));
	const agentDir = join(temp, "custom-agent");
	const shortcutConfig = join(temp, "shortcut.txt");
	const shortcutLog = join(temp, "shortcut.log");
	const keybindingsPath = join(agentDir, "keybindings.json");
	const extension = join(moduleDir(import.meta.url), "fixtures", "blocking-tool-extension.ts");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(shortcutConfig, "ctrl+y");
	writeFileSync(keybindingsPath, JSON.stringify({ "app.tools.expand": "ctrl+x" }));
	const driver = new InteractiveModeDriver(fixtureArgs(extension), {
		ATOMIC_CODING_AGENT_DIR: agentDir,
		ATOMIC_KEYBINDINGS_SHORTCUT_CONFIG_FILE: shortcutConfig,
		ATOMIC_KEYBINDINGS_SHORTCUT_LOG_FILE: shortcutLog,
		ATOMIC_KEYBINDINGS_SESSION_START_DELAY_MS: "9000",
	});
	try {
		await driver.waitFor((report) => report.type === "terminal_ready");
		await driver.waitFor((report) => report.type === "heartbeat" && typeof report.enginePid === "number");
		const postBindWaitStartedAt = performance.now();
		await driver.waitUntilEngineBound("ctrl+y");
		assert.ok(
			performance.now() - postBindWaitStartedAt >= 7_500,
			"semantic engine binding must outlive the former generic eight-second report budget",
		);
		driver.send({ type: "input", data: "\x19" });
		const dispatchDeadline = performance.now() + 3_000;
		while (shortcutInvocations(shortcutLog).length === 0 && performance.now() < dispatchDeadline) await sleep(20);
		assert.deepEqual(shortcutInvocations(shortcutLog), ["ctrl+y"]);
	} finally {
		await driver.stop();
		rmSync(temp, { recursive: true, force: true });
	}
});

serialTest(
	"real engine restart republishes bindings and replaces the remote shortcut catalog",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-shortcut-restart-parity-"));
		const agentDir = join(temp, "custom-agent");
		const shortcutConfig = join(temp, "shortcut.txt");
		const shortcutLog = join(temp, "shortcut.log");
		const toolPidFile = join(temp, "tool.pid");
		const keybindingsPath = join(agentDir, "keybindings.json");
		const extension = join(moduleDir(import.meta.url), "fixtures", "blocking-tool-extension.ts");
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
			const initial = await driver.waitFor(
				(report) => report.type === "heartbeat" && typeof report.enginePid === "number",
			);
			driver.send({ type: "state" });
			const startup = await driver.waitFor(
				(report) => report.type === "state" && report.expandKeys?.[0] === "ctrl+x",
			);
			assert.equal(startup.expandDisplay, "ctrl+x");
			await driver.waitUntilEngineBound("ctrl+y");
			driver.send({ type: "input", data: "\x19" });
			const initialShortcutDeadline = performance.now() + 3_000;
			while (shortcutInvocations(shortcutLog).length === 0 && performance.now() < initialShortcutDeadline)
				await sleep(20);
			assert.deepEqual(shortcutInvocations(shortcutLog), ["ctrl+y"]);

			writeFileSync(keybindingsPath, JSON.stringify({ "app.tools.expand": "ctrl+y" }));
			writeFileSync(shortcutConfig, "ctrl+x");
			driver.send({ type: "input", data: "restart with new shortcuts" });
			await driver.waitFor(
				(report) => report.type === "heartbeat" && report.editorText === "restart with new shortcuts",
			);
			driver.send({ type: "input", data: "\r" });
			while (!existsSync(toolPidFile)) await sleep(10);
			const interruptReadyIndex = driver.reports.length;
			await driver.waitForNext(
				interruptReadyIndex,
				(report) => report.type === "heartbeat" && report.streaming === true,
				ENGINE_REPORT_TIMEOUT_MS,
				"host streaming interrupt readiness",
			);
			// Escape only requests a cooperative abort now; the explicit Ctrl+C escape
			// hatch is what replaces a wedged generation. Wait for THIS tool's stall to
			// cross the watchdog's unresponsive threshold, not an earlier startup stall.
			await driver.waitForNext(
				interruptReadyIndex,
				(report) =>
					report.type === "diagnostic" &&
					report.message?.includes("tool.execute busy_loop") === true &&
					report.message.includes("Esc interrupt · Ctrl+C terminate"),
				ENGINE_REPORT_TIMEOUT_MS,
				"engine unresponsive watchdog diagnostic",
			);
			const terminateIndex = driver.reports.length;
			driver.send({ type: "input", data: "\x03" });
			const recovering = await driver.waitForNext(
				terminateIndex,
				(report) =>
					report.type === "diagnostic" && report.message === "Interactive engine is not responding; restarting.",
				ENGINE_REPORT_TIMEOUT_MS,
				"explicit engine termination notice",
			);
			assert.ok(recovering);
			const probeIndex = driver.reports.length;
			driver.send({ type: "shortcut", data: "\x19" });
			const unavailableProbe = await driver.waitForNext(
				probeIndex,
				(report) => report.type === "shortcut" && report.data === "\x19",
			);
			assert.equal(
				unavailableProbe.shortcutHandled,
				false,
				"generation replacement must invalidate stale shortcuts immediately",
			);

			await driver.waitFor(
				(report) =>
					report.type === "heartbeat" &&
					typeof report.enginePid === "number" &&
					report.enginePid !== initial.enginePid &&
					report.recovering === false,
				12_000,
			);
			const stateIndex = driver.reports.length;
			driver.send({ type: "state" });
			const restarted = await driver.waitForNext(
				stateIndex,
				(report) => report.type === "state" && report.expandKeys?.[0] === "ctrl+y",
			);
			assert.equal(restarted.expandDisplay, "ctrl+y");
			const expandedBefore = restarted.toolsExpanded;
			driver.send({ type: "input", data: "\x19" });
			const updatedStateIndex = driver.reports.length;
			driver.send({ type: "state" });
			const updated = await driver.waitForNext(updatedStateIndex, (report) => report.type === "state");
			assert.notEqual(updated.toolsExpanded, expandedBefore, "new binding must reach host input dispatch");
			assert.deepEqual(
				shortcutInvocations(shortcutLog),
				["ctrl+y"],
				"stale remote key must not dispatch after restart",
			);

			driver.send({ type: "input", data: "\x18" });
			const restartedShortcutDeadline = performance.now() + 3_000;
			while (shortcutInvocations(shortcutLog).length < 2 && performance.now() < restartedShortcutDeadline)
				await sleep(20);
			assert.deepEqual(shortcutInvocations(shortcutLog), ["ctrl+y", "ctrl+x"]);
		} finally {
			await driver.stop();
			rmSync(temp, { recursive: true, force: true });
		}
	},
	30_000,
);
