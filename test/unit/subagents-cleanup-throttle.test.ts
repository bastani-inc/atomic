import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@bastani/atomic";
import { afterEach, describe, test } from "vitest";
import {
	createSubagentStartupMaintenance,
	STARTUP_ARTIFACT_SCAN_DELAY_MS,
} from "../../packages/subagents/src/extension/startup-maintenance.ts";
import { cleanupAllArtifactDirs } from "../../packages/subagents/src/shared/artifacts.js";
import type { SubagentState } from "../../packages/subagents/src/shared/types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const AGENT_DIR_ENV = "ATOMIC_CODING_AGENT_DIR";

const roots: string[] = [];
const savedAgentDirEnv = process.env[AGENT_DIR_ENV];

function makeIsolatedSessionsRoot(): { agentDir: string; sessionsRoot: string } {
	const agentDir = fs.mkdtempSync(join(tmpdir(), "atomic-cleanup-throttle-"));
	roots.push(agentDir);
	const sessionsRoot = join(agentDir, "sessions");
	fs.mkdirSync(sessionsRoot, { recursive: true });
	process.env[AGENT_DIR_ENV] = agentDir;
	return { agentDir, sessionsRoot };
}

function makeStaleSessionArtifacts(sessionsRoot: string, name: string): string {
	const artifactsDir = join(sessionsRoot, name, "subagent-artifacts");
	fs.mkdirSync(artifactsDir, { recursive: true });
	const staleFile = join(artifactsDir, "run_worker_output.md");
	fs.writeFileSync(staleFile, "stale\n");
	const old = new Date(Date.now() - 10 * DAY_MS);
	fs.utimesSync(staleFile, old, old);
	return staleFile;
}

function makeState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		subagentInProgress: false,
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		lastUiContext: null,
	};
}

function pi(): ExtensionAPI {
	return {
		events: {
			emit: () => {},
			on: () => () => {},
		},
	} as unknown as ExtensionAPI;
}

afterEach(() => {
	if (savedAgentDirEnv === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = savedAgentDirEnv;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("session artifact cleanup throttling", () => {
	test("scans once, records a root marker, and skips rescans within the interval", () => {
		const { sessionsRoot } = makeIsolatedSessionsRoot();
		const staleFile = makeStaleSessionArtifacts(sessionsRoot, "session-a");

		cleanupAllArtifactDirs(1);

		assert.equal(fs.existsSync(staleFile), false, "first scan must remove stale artifacts");
		assert.equal(fs.existsSync(join(sessionsRoot, ".last-cleanup")), true, "scan must record a root marker");

		const staleAgain = makeStaleSessionArtifacts(sessionsRoot, "session-b");
		cleanupAllArtifactDirs(1);
		assert.equal(fs.existsSync(staleAgain), true, "a fresh root marker must skip the rescan");
	});

	test("rescans when the root marker is older than the cleanup interval", () => {
		const { sessionsRoot } = makeIsolatedSessionsRoot();
		const markerPath = join(sessionsRoot, ".last-cleanup");
		fs.writeFileSync(markerPath, "0");
		const old = new Date(Date.now() - 2 * DAY_MS);
		fs.utimesSync(markerPath, old, old);
		const staleFile = makeStaleSessionArtifacts(sessionsRoot, "session-a");

		cleanupAllArtifactDirs(1);

		assert.equal(fs.existsSync(staleFile), false, "an expired marker must allow the rescan");
	});

	test("skips the scan while another activation holds the cleanup lock", () => {
		const { sessionsRoot } = makeIsolatedSessionsRoot();
		const lockPath = join(sessionsRoot, ".cleanup.lock");
		fs.writeFileSync(lockPath, String(Date.now()));
		const staleFile = makeStaleSessionArtifacts(sessionsRoot, "session-a");

		cleanupAllArtifactDirs(1);

		assert.equal(fs.existsSync(staleFile), true, "a held lock must skip the concurrent scan");
		assert.equal(fs.existsSync(lockPath), true, "the other holder's lock must remain in place");
		assert.equal(
			fs.existsSync(join(sessionsRoot, ".last-cleanup")),
			false,
			"a skipped scan must not record a marker",
		);
	});

	test("breaks a stale lock left behind by a crashed process", () => {
		const { sessionsRoot } = makeIsolatedSessionsRoot();
		const lockPath = join(sessionsRoot, ".cleanup.lock");
		fs.writeFileSync(lockPath, "0");
		const old = new Date(Date.now() - 2 * DAY_MS);
		fs.utimesSync(lockPath, old, old);
		const staleFile = makeStaleSessionArtifacts(sessionsRoot, "session-a");

		cleanupAllArtifactDirs(1);

		assert.equal(fs.existsSync(staleFile), false, "a stale lock must be broken so cleanup can proceed");
		assert.equal(fs.existsSync(lockPath), false, "the broken lock must be released after the scan");
	});
});

describe("startup maintenance artifact-scan deferral", () => {
	test("defers the global artifact scan by the startup delay and stays cancellable via stop()", () => {
		const { sessionsRoot } = makeIsolatedSessionsRoot();
		const staleFile = makeStaleSessionArtifacts(sessionsRoot, "session-a");
		const state = makeState();
		const macrotasks: Array<() => void> = [];
		const delayed: Array<{ task: () => void; delayMs: number }> = [];
		let cancelledDelayed = 0;
		const maintenance = createSubagentStartupMaintenance(pi(), state, {
			resultsDir: join(sessionsRoot, "results"),
			artifactCleanupDays: 1,
			resultTtlMs: 1000,
			scheduleMacrotask: (task) => {
				macrotasks.push(task);
				return () => undefined;
			},
			scheduleDelayed: (task, delayMs) => {
				delayed.push({ task, delayMs });
				return () => {
					cancelledDelayed++;
				};
			},
		});

		try {
			maintenance.scheduleStartupCleanup();
			assert.equal(delayed.length, 0, "nothing is delayed before the startup macrotask runs");
			assert.equal(macrotasks.length, 1);
			macrotasks[0]!();

			assert.equal(delayed.length, 1, "the global artifact scan must be scheduled with a delay");
			assert.equal(delayed[0]!.delayMs, STARTUP_ARTIFACT_SCAN_DELAY_MS);
			assert.equal(fs.existsSync(staleFile), true, "the slow scan must not run on the startup macrotask");
		} finally {
			maintenance.stop();
		}
		assert.equal(cancelledDelayed, 1, "stop() must cancel the pending delayed scan");

		delayed[0]!.task();
		assert.equal(fs.existsSync(staleFile), false, "the deferred task performs the real scan when it fires");
	});
});
