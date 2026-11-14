import assert from "node:assert/strict";
import { readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox, loseSnapshotBlobs } from "../../../test/helpers/worktree-snapshot.js";
import { latestResumeTimings, RESUME_TIMINGS_TYPE } from "../src/core/resume/timings.js";
import { SessionManager } from "../src/core/session-manager.js";
import { describeLastCapture, SessionWorktreeSnapshotRecorder } from "../src/core/session-worktree-snapshots.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import type { SqlSnapshotBlobStore } from "../src/core/worktree-snapshot/blob-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import { type PreparedSessionResume, type PrepareSessionResumeOptions, prepareSessionResume } from "../src/index.js";
import { forThisHost } from "./helpers/blueprint-fixtures.js";

useTemporaryAgentDir();

const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	vi.restoreAllMocks();
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

async function sqlStore(): Promise<SessionStore> {
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

/**
 * A clone with an uncommitted blueprint, recorded by a session and then gone, so a resume restores and builds it.
 * `unpushed` commits a file first, so the snapshot bundles that commit; `keep` leaves the clone where it is.
 */
async function recordedProject(setup: { unpushed?: boolean; keep?: boolean } = {}) {
	const { clone, remote } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
	if (setup.unpushed) {
		sandbox.write(join(clone, "committed.txt"), "unpushed\n");
		await sandbox.commitAll(clone, "unpushed commit");
	}
	sandbox.write(
		join(clone, ".atomic", "blueprint.yaml"),
		forThisHost(["maintenance:", "  - name: Warm up", "    run: echo warm", ""].join("\n")),
	);
	const store = await sqlStore();
	const manager = await SessionManager.create(store, clone);
	await manager.appendMessage({ role: "user", content: "work on it", timestamp: Date.now() });
	const capture = await captureWorktreeSnapshot(clone, { settings, blobs: store.snapshotBlobs });
	if (capture.status !== "captured") throw new Error(`capture ${capture.status}`);
	await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
	if (!setup.keep) renameSync(clone, sandbox.path("node-a-gone"));
	return { manager, snapshot: capture.snapshot, remote, blobs: store.snapshotBlobs as SqlSnapshotBlobStore };
}

function ready(prepared: PreparedSessionResume): Extract<PreparedSessionResume, { status: "ready" }> {
	assert.equal(prepared.status, "ready");
	if (prepared.status !== "ready") throw new Error("unreachable");
	return prepared;
}

function options(
	entryPoint: PrepareSessionResumeOptions["entryPoint"] = "switch-session",
): PrepareSessionResumeOptions {
	return {
		entryPoint,
		launchCwd: sandbox.root,
		settings,
		storeDir: sandbox.path("host"),
		blueprint: {
			agentDir: sandbox.path("agent"),
			trusted: () => true,
			homeDir: sandbox.path("home"),
			environment: { PATH: process.env.PATH ?? "", HOME: sandbox.path("home") },
		},
	};
}

describe("resume timings of a real resume (#4748)", () => {
	test("a resume that restores and builds a checkout records every phase, each step, within its wall time (#4748)", async () => {
		const { manager } = await recordedProject();
		const started = performance.now();
		const prepared = await prepareSessionResume(manager, options());
		const wallMs = performance.now() - started;
		assert.equal(prepared.status, "ready");
		if (prepared.status !== "ready") throw new Error("unreachable");

		const timings = latestResumeTimings(prepared.sessionManager);
		assert.ok(timings, "the resume recorded its timings");
		assert.equal(timings.restores.length, 1);
		const [restore] = timings.restores;
		assert.equal(restore!.mode, "fresh");
		// The snapshot's commit is pushed, so the restore fetches it at depth 1 (S3).
		assert.equal(restore!.fetch, "shallow");
		for (const phase of ["fetch", "reconstruct", "materialize", "verify", "publish"] as const) {
			assert.equal(typeof restore!.phases[phase], "number", `phase ${phase}`);
		}
		assert.deepEqual(
			timings.blueprint.map((step) => [step.section, step.name, step.exit]),
			[["maintenance", "Warm up", "ok"]],
		);
		const phaseSum =
			Object.values(restore!.phases).reduce((sum, ms) => sum + ms, 0) +
			timings.blueprint.reduce((sum, step) => sum + step.ms, 0);
		assert.ok(phaseSum <= wallMs, `phases ${phaseSum} ms within the resume's ${wallMs} ms`);
		assert.ok(restore!.ms <= wallMs);
		assert.ok(timings.blueprintReadyMs !== null && timings.blueprintReadyMs <= timings.firstPromptReadyMs!);
		assert.ok(timings.firstPromptReadyMs! <= wallMs);

		// The step's log says when it started and finished, and how long it took.
		const logs = join(sandbox.path("host"), "blueprint-logs");
		const [stepLog] = readdirSync(logs).filter((name) => name.endsWith("-maintenance-1.log"));
		assert.ok(stepLog, "the step wrote its log");
		const log = readFileSync(join(logs, stepLog), "utf8");
		assert.match(log, /^# started: \d{4}-\d\d-\d\dT/m);
		assert.match(log, /^# finished: \d{4}-\d\d-\d\dT/m);
		assert.match(log, /^# duration: \d+ ms$/m);
	});

	test("atomic --session counts from the launch of the process (#4748)", async () => {
		const { manager } = await recordedProject();
		const beforeResume = performance.now();
		const timings = latestResumeTimings(ready(await prepareSessionResume(manager, options("cli"))).sessionManager);
		assert.ok(timings);
		assert.equal(timings.startedAt, new Date(performance.timeOrigin).toISOString());
		assert.ok(timings.firstPromptReadyMs! >= Math.floor(beforeResume), "counted from the process launch");
	});

	test("a resume whose commit came from the snapshot's bundle says so (#4748)", async () => {
		const { manager } = await recordedProject({ unpushed: true });
		const timings = latestResumeTimings(ready(await prepareSessionResume(manager, options())).sessionManager);
		assert.deepEqual(
			timings?.restores.map((restore) => [restore.mode, restore.fetch]),
			[["fresh", "bundle"]],
		);
	});

	test("a degraded restore records its mode and the phases of both attempts (#4748)", async () => {
		const { manager, snapshot, blobs } = await recordedProject();
		await loseSnapshotBlobs(blobs, [snapshot.chain.at(-1)!.patch!]);
		const prepared = ready(await prepareSessionResume(manager, options()));
		const timings = latestResumeTimings(prepared.sessionManager);
		assert.equal(timings?.restores.length, 1);
		const [restore] = timings!.restores;
		assert.equal(restore!.mode, "degraded");
		for (const phase of ["fetch", "reconstruct", "materialize", "verify", "publish"] as const) {
			assert.equal(typeof restore!.phases[phase], "number", `phase ${phase}`);
		}
	});

	test("a checkout that could not be restored at all is not reported as restored (#4748)", async () => {
		const { manager, remote, snapshot, blobs } = await recordedProject({ unpushed: true });
		await loseSnapshotBlobs(blobs, [snapshot.bundle!.blob]);
		renameSync(remote, `${remote}-gone`);
		const prepared = ready(await prepareSessionResume(manager, options()));
		assert.equal(prepared.sessionManager.getWorktreeRootMappings().length, 0, "nothing was restored");
		assert.equal(latestResumeTimings(prepared.sessionManager), undefined);
	});

	test("a resume that restores and builds nothing records no timings (#4748)", async () => {
		const { manager } = await recordedProject({ keep: true });
		const prepared = ready(await prepareSessionResume(manager, options()));
		assert.equal(prepared.sessionManager.getWorktreeRootMappings().length, 0);
		assert.equal(latestResumeTimings(prepared.sessionManager), undefined);
		assert.ok(!prepared.sessionManager.getBranch().some((entry) => entry.type === "custom"));
	});

	test("a resume whose timings cannot be written still resumes (#4748)", async () => {
		const { manager } = await recordedProject();
		const append = vi.spyOn(SessionManager.prototype, "appendCustomEntry");
		append.mockImplementation(async (customType: string) => {
			if (customType === RESUME_TIMINGS_TYPE) throw new Error("disk full");
			return "unused";
		});
		const prepared = await prepareSessionResume(manager, options());
		assert.equal(prepared.status, "ready");
		if (prepared.status !== "ready") throw new Error("unreachable");
		assert.ok(append.mock.calls.some(([customType]) => customType === RESUME_TIMINGS_TYPE));
		assert.equal(latestResumeTimings(prepared.sessionManager), undefined);
		assert.notEqual(prepared.sessionManager.getCwd(), manager.getCwd());
	});
});

describe("capture timings (#4748)", () => {
	test("each turn's capture records how long it took, and the latest one is described (#4748)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
		const manager = await SessionManager.create(await sqlStore(), clone);
		const recorder = new SessionWorktreeSnapshotRecorder({
			sessionManager: manager,
			cwd: () => clone,
			settings: () => settings,
			declaresWrites: () => false,
			onUnavailable: () => {},
		});
		assert.equal(describeLastCapture(manager, clone), undefined);
		const turn = (path: string) =>
			fauxAssistantMessage([fauxToolCall("write", { path, content: "" })], { stopReason: "toolUse" });
		sandbox.write(join(clone, "a.txt"), "a\n");
		await recorder.recordTurn(turn(join(clone, "a.txt")));
		const started = performance.now();
		await recorder.recordTurn(turn(join(clone, "a.txt")));
		const wallMs = performance.now() - started;

		const captures = manager.getEntries().flatMap((entry) => (entry.type === "worktree_snapshot" ? [entry] : []));
		assert.equal(captures.length, 2);
		assert.equal(captures[1]!.snapshot, undefined, "the second turn changed nothing");
		const ms = captures[1]!.captureMs;
		assert.equal(typeof ms, "number");
		assert.ok(ms! <= wallMs, `capture ${ms} ms within the turn's ${wallMs} ms`);
		assert.equal(describeLastCapture(manager, clone), `last capture took ${(ms! / 1000).toFixed(1)} s`);

		// On another machine the capture is still the checkout's last, under the worktree it was restored into.
		renameSync(clone, sandbox.path("node-a-gone"));
		const prepared = ready(await prepareSessionResume(manager, options()));
		const [restored] = prepared.sessionManager.getWorktreeRootMappings();
		assert.ok(restored);
		assert.equal(
			describeLastCapture(prepared.sessionManager, restored.to),
			`last capture took ${(ms! / 1000).toFixed(1)} s`,
		);
		assert.equal(describeLastCapture(prepared.sessionManager, sandbox.path("elsewhere")), undefined);
	});
});
