import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { moduleDir, sleep } from "../helpers/runtime.js";
import { DefaultMainDriver, type HarnessReport, isAlive, waitForExit } from "./fixtures/default-main-driver.ts";

/**
 * Reproduction A from the reported freeze, end to end against a real host and a
 * real engine child: a remote `ctx.ui.custom()` component is mounted in the host
 * and the engine child is killed underneath it.
 *
 * Before the fix the host kept the dead component mounted, never settled its
 * `ui.custom()` promise, left the editor detached from `editorContainer`, kept
 * `blockingInlineCustomUiDepth` above zero, and therefore swallowed typing,
 * Escape, and Ctrl+C forever.
 *
 * POSIX-only for the same reason as the sibling default-main suite: it drives
 * SIGKILL and kill(pid, 0) process-tree semantics.
 */
const serialTest = process.platform === "win32" ? test.sequential.skip : test.sequential;

const FORBIDDEN_TEXT = ["Engine terminated;", "result unknown; inspect side effects before retrying"];

function fixtureArgs(temp: string): string[] {
	return [
		"--no-session",
		"--no-extensions",
		// The blocking-tool fixture supplies the offline provider/model; the
		// engine-death fixture supplies the never-resolving custom UI commands.
		"--extension",
		join(moduleDir(import.meta.url), "fixtures", "blocking-tool-extension.ts"),
		"--extension",
		join(moduleDir(import.meta.url), "fixtures", "engine-death-extension.ts"),
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--offline",
		"--approve",
		"--provider",
		"isolation-fixture",
		"--model",
		"blocking-model",
		"--session-dir",
		join(temp, "sessions"),
	];
}

function assertNoForbiddenText(reports: HarnessReport[]): void {
	for (const report of reports) {
		for (const forbidden of FORBIDDEN_TEXT) {
			assert.ok(
				!(report.message?.includes(forbidden) === true) && !(report.output?.includes(forbidden) === true),
				`host surfaced removed termination text ${JSON.stringify(forbidden)}`,
			);
		}
	}
}

async function mountFrozenCustomUi(driver: DefaultMainDriver, command: string, mountFile: string): Promise<number> {
	await driver.waitFor((report) => report.type === "terminal_ready");
	const initial = await driver.waitFor(
		(report) => report.type === "heartbeat" && typeof report.enginePid === "number",
	);
	driver.send({ type: "input", data: command });
	await driver.waitFor((report) => report.type === "heartbeat" && report.editorText === command);
	driver.send({ type: "input", data: "\r" });
	const deadline = performance.now() + 8_000;
	while (!existsSync(mountFile) && performance.now() < deadline) await sleep(20);
	assert.ok(existsSync(mountFile), `${command} never mounted a remote custom UI`);
	return initial.enginePid!;
}

serialTest(
	"engine death tears down a mounted inline remote custom UI and restores the editor",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-engine-death-inline-"));
		const mountFile = join(temp, "mounted.pid");
		const driver = new DefaultMainDriver(fixtureArgs(temp), {
			ATOMIC_CODING_AGENT_DIR: join(temp, "agent"),
			ATOMIC_FREEZE_MOUNT_FILE: mountFile,
			ATOMIC_NONBLOCKING_TOOL: "1",
		});
		try {
			const enginePid = await mountFrozenCustomUi(driver, "/freeze-inline", mountFile);

			// An inline mount replaces the editor and raises the blocking depth: that is
			// the pre-death state the freeze depended on.
			const mounted = await driver.waitFor(
				(report) =>
					report.type === "heartbeat" && report.editorMounted === false && (report.blockingInlineDepth ?? 0) > 0,
			);
			assert.equal(mounted.editorMounted, false);

			const killIndex = driver.reports.length;
			process.kill(enginePid, "SIGKILL");
			await waitForExit(enginePid);

			// Recovery must not wait for a later engine_ready: the editor comes back,
			// takes focus, and the inline depth unwinds to zero.
			const recovered = await driver.waitForNext(
				killIndex,
				(report) =>
					report.type === "heartbeat" &&
					report.editorMounted === true &&
					report.focusIsEditor === true &&
					report.blockingInlineDepth === 0 &&
					report.hasOverlay === false,
				10_000,
			);
			assert.equal(recovered.blockingInlineDepth, 0);

			// The command was accepted and had already mounted its UI, so it is NOT
			// returned as an unsent draft: offering it back would invite a second run
			// of work the child already did (see rpc-pending-requests.ts).
			assert.equal(recovered.editorText, "");
			// The host stays usable: typing lands and one replacement generation binds.
			driver.send({ type: "input", data: "typing after engine death" });
			const typed = await driver.waitForNext(
				driver.reports.length,
				(report) =>
					report.type === "heartbeat" && report.editorText?.endsWith("typing after engine death") === true,
				10_000,
			);
			assert.equal(typed.editorText, "typing after engine death");
			const replaced = await driver.waitForNext(
				killIndex,
				(report) =>
					report.type === "heartbeat" &&
					typeof report.enginePid === "number" &&
					report.enginePid !== enginePid &&
					report.recovering === false,
				15_000,
			);
			assert.notEqual(replaced.enginePid, enginePid);
			assert.ok(isAlive(replaced.enginePid!), "replacement engine child is not alive");
			assertNoForbiddenText(driver.reports);
		} finally {
			await driver.stop();
			rmSync(temp, { recursive: true, force: true });
		}
	},
	45_000,
);

serialTest(
	"engine death hides a mounted overlay remote custom UI and returns focus to the editor",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-engine-death-overlay-"));
		const mountFile = join(temp, "mounted.pid");
		const driver = new DefaultMainDriver(fixtureArgs(temp), {
			ATOMIC_CODING_AGENT_DIR: join(temp, "agent"),
			ATOMIC_FREEZE_MOUNT_FILE: mountFile,
			ATOMIC_NONBLOCKING_TOOL: "1",
		});
		try {
			const enginePid = await mountFrozenCustomUi(driver, "/freeze-overlay", mountFile);
			await driver.waitFor((report) => report.type === "heartbeat" && report.hasOverlay === true);

			const killIndex = driver.reports.length;
			process.kill(enginePid, "SIGKILL");
			await waitForExit(enginePid);

			const recovered = await driver.waitForNext(
				killIndex,
				(report) =>
					report.type === "heartbeat" &&
					report.hasOverlay === false &&
					report.editorMounted === true &&
					report.focusIsEditor === true &&
					report.blockingInlineDepth === 0,
				10_000,
			);
			assert.equal(recovered.hasOverlay, false);
			// Accepted before it died, so the command is not offered back for a rerun.
			assert.equal(recovered.editorText, "");
			driver.send({ type: "input", data: "overlay recovered" });
			const typed = await driver.waitForNext(
				driver.reports.length,
				(report) => report.type === "heartbeat" && report.editorText?.endsWith("overlay recovered") === true,
				10_000,
			);
			assert.equal(typed.editorText, "overlay recovered");
			assertNoForbiddenText(driver.reports);
		} finally {
			await driver.stop();
			rmSync(temp, { recursive: true, force: true });
		}
	},
	45_000,
);

serialTest(
	"engine-death teardown lands before any replacement engine_ready",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-engine-death-order-"));
		const mountFile = join(temp, "mounted.pid");
		const driver = new DefaultMainDriver(fixtureArgs(temp), {
			ATOMIC_CODING_AGENT_DIR: join(temp, "agent"),
			ATOMIC_FREEZE_MOUNT_FILE: mountFile,
			ATOMIC_NONBLOCKING_TOOL: "1",
		});
		try {
			const enginePid = await mountFrozenCustomUi(driver, "/freeze-inline", mountFile);
			await driver.waitFor(
				(report) =>
					report.type === "heartbeat" && report.editorMounted === false && (report.blockingInlineDepth ?? 0) > 0,
			);

			const killIndex = driver.reports.length;
			process.kill(enginePid, "SIGKILL");
			await waitForExit(enginePid);

			// The FIRST restored heartbeat must still predate the replacement's
			// readiness: `getEnginePid()` is cleared on start() and only repopulated by
			// the new child's engine_ready, so a teardown keyed on engine_ready could
			// never produce this report.
			const restored = await driver.waitForNext(
				killIndex,
				(report) =>
					report.type === "heartbeat" && report.editorMounted === true && report.blockingInlineDepth === 0,
				10_000,
			);
			assert.ok(
				restored.enginePid === undefined || restored.enginePid === enginePid,
				`teardown waited for a replacement engine_ready (enginePid=${String(restored.enginePid)})`,
			);
			assert.equal(restored.focusIsEditor, true);
			assertNoForbiddenText(driver.reports);
		} finally {
			await driver.stop();
			rmSync(temp, { recursive: true, force: true });
		}
	},
	45_000,
);

/**
 * Nested mounts: an overlay above an inline proxy. Closing oldest-first made the
 * inline layer restore the editor and then let the overlay hand focus back to
 * the inline proxy it had captured as `preFocus` — a component that was already
 * disposed. Teardown must unwind newest-first.
 */
serialTest(
	"nested remote mounts unwind newest-first and leave focus on the editor",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-engine-death-nested-"));
		const mountFile = join(temp, "mounted.pid");
		const driver = new DefaultMainDriver(fixtureArgs(temp), {
			ATOMIC_CODING_AGENT_DIR: join(temp, "agent"),
			ATOMIC_FREEZE_MOUNT_FILE: mountFile,
			ATOMIC_NONBLOCKING_TOOL: "1",
		});
		try {
			const enginePid = await mountFrozenCustomUi(driver, "/freeze-nested", mountFile);
			// Both layers are live: the editor is displaced by the inline mount and an
			// overlay sits above it.
			const nested = await driver.waitFor(
				(report) =>
					report.type === "heartbeat" &&
					report.hasOverlay === true &&
					report.editorMounted === false &&
					(report.blockingInlineDepth ?? 0) > 0,
				15_000,
			);
			assert.equal(nested.hasOverlay, true);

			const killIndex = driver.reports.length;
			process.kill(enginePid, "SIGKILL");
			await waitForExit(enginePid);

			const recovered = await driver.waitForNext(
				killIndex,
				(report) =>
					report.type === "heartbeat" &&
					report.hasOverlay === false &&
					report.editorMounted === true &&
					report.focusIsEditor === true &&
					report.blockingInlineDepth === 0,
				15_000,
			);
			assert.equal(recovered.focusIsEditor, true, "focus must land on the editor, never on a disposed proxy");
			assert.equal(recovered.focusIsStaleInline, false, "focus must never land on a detached inline proxy");
			// No heartbeat after the kill may ever show focus on a disposed proxy.
			for (const report of driver.reports.slice(killIndex)) {
				assert.notEqual(report.focusIsStaleInline, true, "teardown focused a disposed inline proxy");
			}
			driver.send({ type: "input", data: "usable after nested teardown" });
			const typed = await driver.waitForNext(
				driver.reports.length,
				(report) =>
					report.type === "heartbeat" && report.editorText?.endsWith("usable after nested teardown") === true,
				10_000,
			);
			assert.ok(typed.editorText?.includes("usable after nested teardown"));
			assertNoForbiddenText(driver.reports);
		} finally {
			await driver.stop();
			rmSync(temp, { recursive: true, force: true });
		}
	},
	60_000,
);
