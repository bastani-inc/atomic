import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { moduleDir, sleep } from "../helpers/runtime.js";
import {
	DefaultMainDriver,
	type HarnessReport,
	isAlive,
	waitForExit,
	waitForFile,
} from "./fixtures/default-main-driver.ts";

/**
 * This harness drives POSIX process-tree semantics end to end: SIGKILL of the
 * fixture host, detached grandchildren reaped by the parent-process guardian,
 * and kill(pid, 0) liveness probes. On Windows those semantics differ enough
 * that the harness can wedge the whole bun test process (observed as a CI job
 * hanging until the 6h timeout), so the suite is POSIX-only until a
 * Windows-safe harness exists.
 */
const serialTest = process.platform === "win32" ? test.sequential.skip : test.sequential;

serialTest("PID-file polling ignores an observable empty file while the writer is publishing", async () => {
	const temp = mkdtempSync(join(tmpdir(), "atomic-pid-file-"));
	const path = join(temp, "process.pid");
	writeFileSync(path, "", "utf8");
	const publish = sleep(25).then(() => writeFileSync(path, "123", "utf8"));
	try {
		assert.equal(await waitForFile(path), 123);
	} finally {
		await publish;
		rmSync(temp, { recursive: true, force: true });
	}
});

function maximumGap(values: readonly number[]): number {
	let maximum = 0;
	for (let index = 1; index < values.length; index += 1)
		maximum = Math.max(maximum, values[index]! - values[index - 1]!);
	return maximum;
}

function fixtureArgs(extension: string): string[] {
	return [
		// --approve pins project trust for this run so a fresh agent dir (CI, containers)
		// never blocks startup on the interactive "Trust project folder?" prompt.
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
function settingsEntryCounts(path: string): Record<"model_change" | "session_info" | "thinking_level_change", number> {
	const counts = { model_change: 0, session_info: 0, thinking_level_change: 0 };
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line) continue;
		const entry = JSON.parse(line) as { type?: string };
		if (entry.type === "model_change" || entry.type === "session_info" || entry.type === "thinking_level_change")
			counts[entry.type] += 1;
	}
	return counts;
}

const FORBIDDEN_TERMINATION_TEXT = ["Engine terminated;", "result unknown; inspect side effects before retrying"];

function assertNoForbiddenTerminationText(reports: HarnessReport[]): void {
	for (const report of reports) {
		for (const forbidden of FORBIDDEN_TERMINATION_TEXT) {
			assert.ok(
				!(report.message?.includes(forbidden) === true) && !(report.output?.includes(forbidden) === true),
				`host surfaced removed termination text ${JSON.stringify(forbidden)}: ${JSON.stringify(report).slice(0, 400)}`,
			);
		}
	}
}

serialTest(
	"Escape never terminates a wedged engine; explicit Ctrl+C kills the full blocked process tree",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-default-main-"));
		const toolPidFile = join(temp, "tool.pid");
		const grandchildPidFile = join(temp, "grandchild.pid");
		const driver = new DefaultMainDriver(
			fixtureArgs(join(moduleDir(import.meta.url), "fixtures", "blocking-tool-extension.ts")),
			{
				ATOMIC_BLOCKING_TOOL_PID_FILE: toolPidFile,
				ATOMIC_BLOCKING_GRANDCHILD_PID_FILE: grandchildPidFile,
				ATOMIC_CODING_AGENT_DIR: join(temp, "agent"),
			},
		);
		try {
			await driver.waitFor((report) => report.type === "terminal_ready");
			const initial = await driver.waitFor(
				(report) => report.type === "heartbeat" && typeof report.enginePid === "number",
			);
			driver.send({ type: "input", data: "run the blocking tool" });
			await driver.waitFor((report) => report.type === "heartbeat" && report.editorText === "run the blocking tool");
			driver.send({ type: "input", data: "\r" });
			const toolPid = await waitForFile(toolPidFile);
			const grandchildPid = await waitForFile(grandchildPidFile);
			assert.equal(toolPid, initial.enginePid);
			assert.ok(isAlive(grandchildPid));
			// The watchdog's own copy promises "Esc interrupt · Ctrl+C terminate".
			await driver.waitFor(
				(report) =>
					report.type === "diagnostic" &&
					report.message?.includes("tool.execute busy_loop") === true &&
					report.message.includes("Esc interrupt · Ctrl+C terminate"),
			);

			// Escape requests the engine's cooperative abort and waits. It must never
			// terminate or replace the child, even for a wedged one.
			const beforeEscapeReports = driver.reports.length;
			driver.send({ type: "input", data: "\u001b" });
			await sleep(1_500);
			const afterEscape = driver.reports
				.slice(beforeEscapeReports)
				.filter((report) => report.type === "heartbeat" && typeof report.enginePid === "number");
			assert.ok(afterEscape.length > 20, "host heartbeat stalled while the cooperative abort was pending");
			for (const report of afterEscape) {
				assert.equal(report.enginePid, toolPid, "Escape replaced the engine child");
				assert.equal(report.generation, initial.generation, "Escape replaced the engine generation");
			}
			assert.ok(isAlive(toolPid), "Escape terminated the engine child");
			assert.ok(isAlive(grandchildPid), "Escape terminated the engine process tree");
			assertNoForbiddenTerminationText(driver.reports);

			// Ctrl+C is the explicit escape hatch: it terminates and recovers.
			driver.send({ type: "input", data: "\x03" });
			const restarted = await driver.waitFor(
				(report) =>
					report.type === "heartbeat" &&
					typeof report.enginePid === "number" &&
					report.enginePid !== toolPid &&
					report.recovering === false,
				15_000,
			);
			assert.notEqual(restarted.enginePid, toolPid);
			await waitForExit(toolPid);
			await waitForExit(grandchildPid);
			driver.send({ type: "input", data: "prove recovery" });
			const usable = await driver.waitFor(
				(report) => report.type === "heartbeat" && report.editorText === "prove recovery",
			);
			assert.equal(usable.editorText, "prove recovery");
			const heartbeats = driver.reports
				.slice(beforeEscapeReports)
				.filter(
					(report): report is HarnessReport & { at: number } =>
						report.type === "heartbeat" && typeof report.at === "number",
				)
				.map((report) => report.at);
			assert.ok(heartbeats.length > 20, "host heartbeat did not remain active through cancellation and restart");
			assert.ok(maximumGap(heartbeats) <= 100, `host heartbeat gap was ${maximumGap(heartbeats).toFixed(1)} ms`);
			assertNoForbiddenTerminationText(driver.reports);
		} finally {
			await driver.stop();
			rmSync(temp, { recursive: true, force: true });
		}
	},
	40_000,
);

serialTest(
	"forced default-main host death leaves no engine or detached grandchild",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-host-death-"));
		const toolPidFile = join(temp, "tool.pid");
		const grandchildPidFile = join(temp, "grandchild.pid");
		const driver = new DefaultMainDriver(
			fixtureArgs(join(moduleDir(import.meta.url), "fixtures", "blocking-tool-extension.ts")),
			{
				ATOMIC_BLOCKING_TOOL_PID_FILE: toolPidFile,
				ATOMIC_BLOCKING_GRANDCHILD_PID_FILE: grandchildPidFile,
				ATOMIC_CODING_AGENT_DIR: join(temp, "agent"),
			},
		);
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
	},
	20_000,
);

serialTest(
	"default InteractiveMode host mutations persist exactly once in the engine",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-exact-once-"));
		const extension = join(moduleDir(import.meta.url), "fixtures", "blocking-tool-extension.ts");
		const args = fixtureArgs(extension).filter((value) => value !== "--no-session");
		args.push("--session-dir", join(temp, "sessions"));
		const toolPidFile = join(temp, "tool.pid");
		const driver = new DefaultMainDriver(args, {
			ATOMIC_CODING_AGENT_DIR: join(temp, "agent"),
			ATOMIC_BLOCKING_TOOL_PID_FILE: toolPidFile,
			ATOMIC_NONBLOCKING_TOOL: "1",
		});
		try {
			await driver.waitFor((report) => report.type === "terminal_ready");
			await driver.waitFor((report) => report.type === "heartbeat" && typeof report.enginePid === "number");
			driver.send({ type: "input", data: "create persisted session" });
			await driver.waitFor(
				(report) => report.type === "heartbeat" && report.editorText === "create persisted session",
			);
			driver.send({ type: "input", data: "\r" });
			await driver.waitFor((report) => report.type === "session_event" && report.eventType === "agent_end");
			driver.send({ type: "state" });
			const state = await driver.waitFor(
				(report) => report.type === "state" && typeof report.sessionFile === "string",
			);
			const before = settingsEntryCounts(state.sessionFile!);
			driver.send({ type: "mutate" });
			const done = await driver.waitFor(
				(report) => report.type === "mutation_done" && report.sessionFile === state.sessionFile,
			);
			assert.equal(done.sessionFile, state.sessionFile);
			const after = settingsEntryCounts(state.sessionFile!);
			assert.equal(after.model_change - before.model_change, 1);
			assert.equal(after.thinking_level_change - before.thinking_level_change, 1);
			assert.equal(after.session_info - before.session_info, 1);
		} finally {
			await driver.stop();
			rmSync(temp, { recursive: true, force: true });
		}
	},
	20_000,
);

serialTest(
	"default InteractiveMode preserves child-owned custom renderers and factory widgets",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-render-parity-"));
		const rendererPidFile = join(temp, "renderer.pid");
		const widgetPidFile = join(temp, "widget.pid");
		const toolPidFile = join(temp, "tool.pid");
		const toolRendererPidFile = join(temp, "tool-renderer.pid");
		const extension = join(moduleDir(import.meta.url), "fixtures", "blocking-tool-extension.ts");
		const driver = new DefaultMainDriver(fixtureArgs(extension), {
			ATOMIC_RENDERER_FIXTURE: "1",
			ATOMIC_RENDERER_PID_FILE: rendererPidFile,
			ATOMIC_WIDGET_PID_FILE: widgetPidFile,
			ATOMIC_CODING_AGENT_DIR: join(temp, "agent"),
			ATOMIC_BLOCKING_TOOL_PID_FILE: toolPidFile,
			ATOMIC_TOOL_RENDERER_PID_FILE: toolRendererPidFile,
			ATOMIC_NONBLOCKING_TOOL: "1",
		});
		try {
			const ready = await driver.waitFor((report) => report.type === "terminal_ready");
			await driver.waitFor(
				(report) => report.type === "render" && report.output?.includes("factory widget parity") === true,
			);
			assert.notEqual(await waitForFile(widgetPidFile), ready.hostPid);
			// The fixture-message is sent on the first agent turn, so the custom
			// renderer parity render is only expected after input starts a turn.
			driver.send({ type: "input", data: "render the tool" });
			await driver.waitFor((report) => report.type === "heartbeat" && report.editorText === "render the tool");
			driver.send({ type: "input", data: "\r" });
			await driver.waitFor(
				(report) => report.type === "render" && report.output?.includes("custom renderer parity") === true,
			);
			assert.notEqual(await waitForFile(rendererPidFile), ready.hostPid);
			await driver.waitFor(
				(report) => report.type === "render" && report.output?.includes("child tool renderer:busy-call") === true,
			);
			assert.equal(await waitForFile(toolRendererPidFile), await waitForFile(toolPidFile));
		} finally {
			await driver.stop();
			rmSync(temp, { recursive: true, force: true });
		}
	},
	20_000,
);

function commandNames(items: HarnessReport["items"]): Set<string> {
	const names = new Set<string>();
	for (const item of items ?? []) {
		const raw = item.label ?? item.value ?? "";
		names.add(raw.replace(/^\//, "").trim());
	}
	return names;
}

async function listSlashCommands(driver: DefaultMainDriver, prefix: string, timeoutMs = 8_000): Promise<Set<string>> {
	const from = driver.reports.length;
	driver.send({ type: "autocomplete", data: prefix });
	const report = await driver.waitForNext(from, (r) => r.type === "autocomplete" && r.prefix === prefix, timeoutMs);
	return commandNames(report.items);
}

async function waitForSlashCommands(
	driver: DefaultMainDriver,
	prefix: string,
	required: string[],
	timeoutMs = 10_000,
): Promise<Set<string>> {
	const deadline = performance.now() + timeoutMs;
	let names = new Set<string>();
	while (performance.now() < deadline) {
		names = await listSlashCommands(driver, prefix);
		if (required.every((name) => names.has(name))) return names;
		await sleep(50);
	}
	throw new Error(`Autocomplete for '${prefix}' never listed ${required.join(", ")}. Saw: ${[...names].join(", ")}`);
}

function invocationPids(logPath: string, name: string): number[] {
	if (!existsSync(logPath)) return [];
	const pids: number[] = [];
	for (const line of readFileSync(logPath, "utf8").split("\n")) {
		if (!line) continue;
		const entry = JSON.parse(line) as { name?: string; pid?: number };
		if (entry.name === name && typeof entry.pid === "number") pids.push(entry.pid);
	}
	return pids;
}

/**
 * Type a slash command and wait for its engine-side invocation. Text typed this
 * fast can land in the startup input-capture window, where the host replays a
 * completed slash draft as an executed command without the text ever appearing
 * in the editor. Tolerate both paths: submit with Enter once the editor shows
 * the draft, or accept the replay-executed invocation directly.
 */
async function invokeSlashCommand(
	driver: DefaultMainDriver,
	logPath: string,
	name: string,
	text: string,
	timeoutMs = 8_000,
): Promise<number> {
	const before = invocationPids(logPath, name).length;
	const from = driver.reports.length;
	driver.send({ type: "input", data: text });
	const deadline = performance.now() + timeoutMs;
	let submitted = false;
	while (performance.now() < deadline) {
		const pids = invocationPids(logPath, name);
		if (pids.length > before) return pids[pids.length - 1]!;
		if (
			!submitted &&
			driver.reports.slice(from).some((report) => report.type === "heartbeat" && report.editorText === text)
		) {
			submitted = true;
			driver.send({ type: "input", data: "\r" });
		}
		await sleep(20);
	}
	throw new Error(`Command '${name}' was never invoked after typing ${JSON.stringify(text)} (log: ${logPath})`);
}

serialTest(
	"isolated default main lists and executes engine-only /workflow and /workflows while the host has no extensions",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-remote-commands-"));
		const extension = join(moduleDir(import.meta.url), "fixtures", "workflow-command-extension.ts");
		// Reproduction parity with `bun packages/coding-agent/src/cli.ts` from the
		// worktree: interactive host isolates extensions, engine child owns them.
		const args = fixtureArgs(extension).filter((value) => value !== "--no-session");
		args.push("--session-dir", join(temp, "sessions"));
		const logFile = join(temp, "commands.log");
		const toolPidFile = join(temp, "tool.pid");
		const driver = new DefaultMainDriver(args, {
			ATOMIC_CODING_AGENT_DIR: join(temp, "agent"),
			ATOMIC_WORKFLOW_COMMAND_LOG: logFile,
			ATOMIC_WORKFLOW_TOOL_PID_FILE: toolPidFile,
		});
		try {
			await driver.waitFor((report) => report.type === "terminal_ready");
			const initial = await driver.waitFor(
				(report) => report.type === "heartbeat" && typeof report.enginePid === "number",
			);
			const enginePid = initial.enginePid!;

			// The engine-only extension commands must surface in host autocomplete even
			// though the host session itself loaded zero extensions.
			const names = await waitForSlashCommands(driver, "/workflow", ["workflow", "workflows"]);
			assert.ok(names.has("workflow"), "autocomplete missing /workflow");
			assert.ok(names.has("workflows"), "autocomplete missing /workflows alias");

			// Executing them routes through the engine child (handler pid === engine pid).
			assert.equal(await invokeSlashCommand(driver, logFile, "workflow", "/workflow list"), enginePid);
			assert.equal(await invokeSlashCommand(driver, logFile, "workflows", "/workflows"), enginePid);

			// Force an engine restart and confirm the catalog is re-fetched: the child
			// commands remain listed under the new engine generation. Escape can no
			// longer replace a generation, so drive the explicit Ctrl+C escape hatch
			// once the watchdog has reported the wedged child unresponsive.
			driver.send({ type: "input", data: "restart the engine" });
			await driver.waitFor((report) => report.type === "heartbeat" && report.editorText === "restart the engine");
			const wedgeIndex = driver.reports.length;
			driver.send({ type: "input", data: "\r" });
			await waitForFile(toolPidFile);
			await driver.waitForNext(
				wedgeIndex,
				(report) =>
					report.type === "diagnostic" && report.message?.includes("Esc interrupt · Ctrl+C terminate") === true,
			);
			driver.send({ type: "input", data: "\x03" });
			const restarted = await driver.waitFor(
				(report) =>
					report.type === "heartbeat" &&
					typeof report.enginePid === "number" &&
					report.enginePid !== enginePid &&
					report.recovering === false,
				12_000,
			);
			assert.notEqual(restarted.enginePid, enginePid);

			const afterRestart = await waitForSlashCommands(driver, "/workflow", ["workflow", "workflows"]);
			assert.ok(afterRestart.has("workflow"), "/workflow missing after engine restart");
			assert.ok(afterRestart.has("workflows"), "/workflows missing after engine restart");
		} finally {
			await driver.stop();
			rmSync(temp, { recursive: true, force: true });
		}
	},
	30_000,
);
