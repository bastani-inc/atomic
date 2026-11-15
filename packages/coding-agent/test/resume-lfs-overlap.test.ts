import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import type { SpawnFault } from "../../../test/helpers/worktree-snapshot-faults.js";

/**
 * What every `git lfs pull` a resume starts runs instead, once a test sets it; the other Git commands run as they are.
 * The fake starts with the arguments of the real pull, so it can run it.
 */
const lfs = vi.hoisted(() => ({
	fault: undefined as ((command: string, args: readonly string[]) => SpawnFault) | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const { gitCommand, withSpawnFaults } = await import("../../../test/helpers/worktree-snapshot-faults.js");
	return withSpawnFaults(await importOriginal(), (request) => {
		const command = gitCommand(request.args);
		if (lfs.fault === undefined || command[0] !== "lfs" || command[1] !== "pull") return undefined;
		return lfs.fault(request.command, request.args);
	});
});

import { failingCommand } from "../../../test/helpers/worktree-snapshot-faults.js";
import { awaitBlueprintReady } from "../src/core/resume/blueprint/barrier.ts";
import { resumeStoreDir } from "../src/core/resume/session-resume.ts";
import { latestResumeTimings } from "../src/core/resume/timings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { formatWorktreeRestoreWarning } from "../src/core/session-worktree-snapshots.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import { type PreparedSessionResume, type PrepareSessionResumeOptions, prepareSessionResume } from "../src/index.ts";
import { forThisHost } from "./helpers/blueprint-fixtures.ts";

useTemporaryAgentDir();

const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
/** The content of the LFS file of the second repository, which only its LFS download puts in place of the pointer. */
const LFS_CONTENT = "LFS-CONTENT-5099";
/** How long the fake LFS download runs once the first repository's blueprint started, so the two overlap visibly. */
const SLOW_LFS_MS = 3_000;
/** How long the fake LFS download waits for the first repository's blueprint to start before it gives up on it. */
const BUILD_START_CAP_MS = 20_000;
/** Two restores, an LFS download, two blueprint builds, and a fake download that waits for one of them. */
const OVERLAPPED_RESUME_TIMEOUT_MS = 90_000;

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	lfs.fault = undefined;
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

/** Where the blueprint steps and the fake LFS download write what they did, in order. */
const markers = () => sandbox.path("markers.txt");
/** The file the first repository's blueprint waits for; the fake LFS download writes it when it ends. */
const gate = () => sandbox.path("gate");
const shellPath = (path: string) => path.replaceAll("\\", "/");
const ran = () => (existsSync(markers()) ? readFileSync(markers(), "utf8").trim().split("\n") : []);

/**
 * A `git lfs pull` that waits until the first repository's blueprint has started, at most {@link BUILD_START_CAP_MS},
 * notes whether it saw it, runs {@link SLOW_LFS_MS} longer, then runs the real pull and opens {@link gate}.
 */
function slowLfsAfterBuildStarts(command: string, args: readonly string[]): SpawnFault {
	const script = `
		const fs = require("node:fs");
		const { spawnSync } = require("node:child_process");
		const [markers, gate, command, ...args] = process.argv.slice(1);
		const deadline = Date.now() + ${BUILD_START_CAP_MS};
		const started = () => fs.existsSync(markers) && fs.readFileSync(markers, "utf8").includes("started-a");
		const wait = () => {
			if (!started() && Date.now() < deadline) return setTimeout(wait, 20);
			fs.appendFileSync(markers, (started() ? "lfs-during-build-a" : "lfs-before-build-a") + "\\n");
			setTimeout(() => {
				const pulled = spawnSync(command, args, { stdio: "inherit" });
				fs.appendFileSync(markers, "lfs-done\\n");
				fs.writeFileSync(gate, "");
				process.exit(pulled.status ?? 1);
			}, ${SLOW_LFS_MS});
		};
		wait();
	`;
	return { command: process.execPath, args: ["-e", script, markers(), gate(), command, ...args] };
}

/** A `git lfs pull` that runs the real pull {@link SLOW_LFS_MS} late, and notes when it ended. */
function slowLfs(command: string, args: readonly string[]): SpawnFault {
	const script = `
		const fs = require("node:fs");
		const { spawnSync } = require("node:child_process");
		const [markers, command, ...args] = process.argv.slice(1);
		setTimeout(() => {
			const pulled = spawnSync(command, args, { stdio: "inherit" });
			fs.appendFileSync(markers, "lfs-done\\n");
			process.exit(pulled.status ?? 1);
		}, ${SLOW_LFS_MS});
	`;
	return { command: process.execPath, args: ["-e", script, markers(), command, ...args] };
}

/** A `git lfs pull` that notes it started and then never ends, as a download cut off by the process exiting would. */
function hangingLfs(): SpawnFault {
	const script = `require("node:fs").appendFileSync(process.argv[1], "lfs-started\\n"); setTimeout(() => {}, 600000);`;
	return { command: process.execPath, args: ["-e", script, markers()] };
}

async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + BUILD_START_CAP_MS;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function sqlStore(): Promise<SqlSessionStore> {
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

/**
 * A session that works in a clone of repository A, whose blueprint waits for {@link gate}, and that also recorded a
 * clone of repository B, which tracks `data.bin` with Git LFS and whose blueprint notes what `data.bin` holds. Both
 * clones are then gone, so a resume restores A first, as the checkout the session works in, then B.
 */
async function recordedTwoRepositories(): Promise<SessionManager> {
	await sandbox.git(sandbox.root, "lfs", "install", "--skip-repo");
	const a = await sandbox.remoteWithClone("repo-a", { "README.md": "a\n" });
	sandbox.write(
		join(a.clone, ".atomic", "blueprint.yaml"),
		forThisHost(
			[
				"maintenance:",
				"  - name: Build A",
				"    run: |",
				`      echo started-a >> "${shellPath(markers())}"`,
				`      while [ ! -f "${shellPath(gate())}" ]; do sleep 0.05; done`,
				`      echo built-a >> "${shellPath(markers())}"`,
				"",
			].join("\n"),
		),
	);
	const b = await sandbox.remoteWithClone("repo-b", {
		".gitattributes": "*.bin filter=lfs -text\n",
		"data.bin": `${LFS_CONTENT}\n`,
	});
	await sandbox.git(b.clone, "lfs", "push", "--all", "origin");
	sandbox.write(
		join(b.clone, ".atomic", "blueprint.yaml"),
		forThisHost(
			[
				"maintenance:",
				"  - name: Build B",
				"    run: |",
				`      echo "started-b $(head -c 16 data.bin)" >> "${shellPath(markers())}"`,
				"",
			].join("\n"),
		),
	);
	const store = await sqlStore();
	const manager = await SessionManager.create(store, a.clone);
	await manager.appendMessage({ role: "user", content: "work on both", timestamp: Date.now() });
	for (const clone of [a.clone, b.clone]) {
		const capture = await captureWorktreeSnapshot(clone, { settings, blobs: store.snapshotBlobs });
		if (capture.status !== "captured") throw new Error(`the snapshot of ${clone} was not captured`);
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
	}
	renameSync(a.clone, sandbox.path("node-a-gone-a"));
	renameSync(b.clone, sandbox.path("node-a-gone-b"));
	return manager;
}

/** {@link recordedTwoRepositories}, resumed until B's LFS download started and then interrupted. */
async function interruptedDuringLfs(): Promise<SessionManager> {
	const manager = await recordedTwoRepositories();
	sandbox.write(gate(), "");
	lfs.fault = hangingLfs;
	const interrupt = new AbortController();
	const interrupted = prepareSessionResume(manager, { ...options(), signal: interrupt.signal });
	await until(() => ran().includes("lfs-started"), "the LFS download to start");
	interrupt.abort(new Error("interrupted"));
	await assert.rejects(interrupted, /interrupted/);
	assert.ok(!ran().some((line) => line.startsWith("started-b")), "B was never built");
	return manager;
}

function options(waitForBlueprint?: "prompt" | "tools"): PrepareSessionResumeOptions {
	return {
		entryPoint: "switch-session",
		launchCwd: sandbox.root,
		settings,
		storeDir: resumeStoreDir(sandbox.path("agent")),
		blueprint: {
			agentDir: sandbox.path("agent"),
			trusted: () => true,
			homeDir: sandbox.path("home"),
			environment: { PATH: process.env.PATH ?? "", HOME: sandbox.path("home") },
		},
		...(waitForBlueprint === undefined ? {} : { waitForBlueprint }),
	};
}

function ready(prepared: PreparedSessionResume): Extract<PreparedSessionResume, { status: "ready" }> {
	if (prepared.status !== "ready") throw new Error("the resume did not open the session");
	return prepared;
}

describe("a multi-repository resume overlaps one repository's LFS download with the others' builds (#5099)", () => {
	test(
		"the LFS download of the second repository runs during the first one's blueprint, as its recorded timings show (#5099)",
		async () => {
			const manager = await recordedTwoRepositories();
			lfs.fault = slowLfsAfterBuildStarts;
			const prepared = ready(await prepareSessionResume(manager, options()));

			assert.deepEqual(ran().slice(0, 4), ["started-a", "lfs-during-build-a", "lfs-done", "built-a"]);
			const timings = latestResumeTimings(prepared.sessionManager);
			assert.ok(timings, "the resume recorded its timings");
			const [restoreA, restoreB] = timings.restores;
			assert.equal(restoreA?.phases.lfs, undefined, "repository A has no LFS files");
			assert.ok(restoreB?.phases.lfs !== undefined, "repository B's download is its own LFS phase");
			assert.ok(restoreB.phases.lfs >= SLOW_LFS_MS, `LFS ${restoreB.phases.lfs} ms`);
			assert.ok(restoreB.ms >= restoreB.phases.lfs, "B's restore lasts until its LFS download ended");
			const buildA = timings.blueprint.find((step) => step.name === "Build A");
			assert.ok(buildA !== undefined && buildA.ms >= SLOW_LFS_MS, `Build A ${buildA?.ms} ms`);
			// One after the other, the download and the build would take at least their sum before the first prompt.
			assert.ok(
				restoreB.phases.lfs + buildA.ms > timings.firstPromptReadyMs!,
				`LFS ${restoreB.phases.lfs} ms and Build A ${buildA.ms} ms overlap within ${timings.firstPromptReadyMs} ms`,
			);
		},
		OVERLAPPED_RESUME_TIMEOUT_MS,
	);

	test(
		"a repository's blueprint starts only once its own LFS files are in place (#5099)",
		async () => {
			const manager = await recordedTwoRepositories();
			// A's build does not wait, so B's would start while the download still runs, unless it waits for it.
			sandbox.write(gate(), "");
			lfs.fault = slowLfs;
			const prepared = ready(await prepareSessionResume(manager, options()));

			const order = ran();
			assert.ok(
				order.indexOf("lfs-done") < order.findIndex((line) => line.startsWith("started-b")),
				order.join(", "),
			);
			assert.ok(
				order.includes(`started-b ${LFS_CONTENT}`),
				`B's blueprint read the LFS content: ${order.join(", ")}`,
			);
			assert.deepEqual(
				prepared.notices.filter((notice) => notice.type === "warning" && /LFS/.test(notice.message)),
				[],
			);
		},
		OVERLAPPED_RESUME_TIMEOUT_MS,
	);

	test(
		"a failed LFS download still resumes, builds the repository and warns once about its pointer files (#5099)",
		async () => {
			const manager = await recordedTwoRepositories();
			// The gate is open, so repository A's build does not wait for a download that never comes.
			sandbox.write(gate(), "");
			lfs.fault = () => failingCommand(1, "batch request: missing protocol");
			const prepared = ready(await prepareSessionResume(manager, options()));

			const warning = formatWorktreeRestoreWarning({ code: "lfs-objects-unavailable", paths: ["data.bin"] });
			assert.equal(prepared.notices.filter((notice) => notice.message === warning).length, 1);
			assert.deepEqual(
				prepared.blueprintNotices.filter((notice) => notice.message === warning),
				[{ type: "warning", message: warning }],
				"the TUI, which shows the build's notices, gets the warning too",
			);
			const order = ran();
			assert.ok(order.includes("built-a"), order.join(", "));
			const builtB = order.find((line) => line.startsWith("started-b"));
			assert.ok(builtB?.startsWith("started-b version https"), `B was built on its pointer file: ${builtB}`);
		},
		OVERLAPPED_RESUME_TIMEOUT_MS,
	);

	test(
		'with "tools" the session is ready before the LFS download ends, and the tools wait for it and the build (#5099)',
		async () => {
			const manager = await recordedTwoRepositories();
			lfs.fault = slowLfsAfterBuildStarts;
			const prepared = ready(await prepareSessionResume(manager, options("tools")));
			assert.ok(!ran().includes("lfs-done"), `ready before the download ended: ${ran().join(", ")}`);

			await awaitBlueprintReady(prepared.sessionManager.getSessionId());
			const order = ran();
			assert.ok(order.indexOf("lfs-done") < order.indexOf(`started-b ${LFS_CONTENT}`), order.join(", "));
			const timings = latestResumeTimings(prepared.sessionManager);
			assert.ok(timings?.restores[1]?.phases.lfs !== undefined, "the settled build records B's LFS phase");
			assert.ok(timings.restores[1].phases.lfs >= SLOW_LFS_MS, `LFS ${timings.restores[1].phases.lfs} ms`);
		},
		OVERLAPPED_RESUME_TIMEOUT_MS,
	);

	test(
		'with "tools" the report of the build carries the warning of a failed LFS download (#5099)',
		async () => {
			const manager = await recordedTwoRepositories();
			sandbox.write(gate(), "");
			lfs.fault = () => failingCommand(1, "batch request: missing protocol");
			const prepared = ready(await prepareSessionResume(manager, options("tools")));

			const report = await awaitBlueprintReady(prepared.sessionManager.getSessionId());
			const warning = formatWorktreeRestoreWarning({ code: "lfs-objects-unavailable", paths: ["data.bin"] });
			assert.ok(report?.includes(`- ${warning}`), String(report));
		},
		OVERLAPPED_RESUME_TIMEOUT_MS,
	);

	test(
		"a resume interrupted during the LFS download leaves it pending, and the next resume finishes it before the blueprint runs (#5099)",
		async () => {
			const manager = await interruptedDuringLfs();
			lfs.fault = undefined;
			const prepared = ready(await prepareSessionResume(manager, options()));
			assert.ok(
				ran().includes(`started-b ${LFS_CONTENT}`),
				`B's blueprint read the LFS content: ${ran().join(", ")}`,
			);
			assert.deepEqual(
				prepared.notices.filter((notice) => /LFS/.test(notice.message) && notice.type === "warning"),
				[],
			);
		},
		OVERLAPPED_RESUME_TIMEOUT_MS,
	);

	test(
		"the next resume warns when the LFS download an interrupted resume left pending still fails (#5099)",
		async () => {
			const manager = await interruptedDuringLfs();
			lfs.fault = () => failingCommand(1, "batch request: missing protocol");
			const prepared = ready(await prepareSessionResume(manager, options()));
			const warning = formatWorktreeRestoreWarning({ code: "lfs-objects-unavailable", paths: ["data.bin"] });
			assert.deepEqual(
				prepared.notices.filter((notice) => notice.message === warning),
				[{ type: "warning", message: warning }],
			);
		},
		OVERLAPPED_RESUME_TIMEOUT_MS,
	);

	test(
		"the next resume clears the Git locks a download killed during its Git steps left, and finishes it (#5099)",
		async () => {
			const manager = await interruptedDuringLfs();
			const worktree = manager.getWorktreeRootMappings().find((mapping) => mapping.from.endsWith("repo-b"))!.to;
			// What a kill between the download's own Git steps leaves: their locks in the worktree's Git directory.
			for (const lock of ["HEAD.lock", "index.lock"]) {
				sandbox.write(await sandbox.git(worktree, "rev-parse", "--path-format=absolute", "--git-path", lock), "");
			}

			lfs.fault = undefined;
			const prepared = ready(await prepareSessionResume(manager, options()));
			assert.ok(
				ran().includes(`started-b ${LFS_CONTENT}`),
				`B's blueprint read the LFS content: ${ran().join(", ")}`,
			);
			assert.deepEqual(
				prepared.notices.filter((notice) => /LFS/.test(notice.message) && notice.type === "warning"),
				[],
			);
			const head = await sandbox.git(worktree, "rev-parse", "HEAD");
			const recorded = manager.getWorktreeSnapshotRecords();
			assert.ok(
				[...recorded.values()].some((snapshot) => snapshot.head === head),
				"HEAD is the snapshot's commit again",
			);
			await sandbox.git(worktree, "commit", "-q", "--allow-empty", "-m", "the index is not locked");
		},
		OVERLAPPED_RESUME_TIMEOUT_MS,
	);
});
