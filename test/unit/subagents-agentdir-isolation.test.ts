import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { afterEach, describe, test, vi } from "vitest";
import { createSubagentStartupMaintenance } from "../../packages/subagents/src/extension/startup-maintenance.ts";
import type { SubagentState } from "../../packages/subagents/src/shared/types.ts";

const pathRecorder = vi.hoisted(() => ({ active: false, paths: [] as string[] }));

// Record every path handed to the fs probes the artifact scan uses, so the test
// can prove the global sessions roots are never touched with an isolated agentDir.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const record = (target: fs.PathLike): void => {
		if (pathRecorder.active) pathRecorder.paths.push(String(target));
	};
	const patched = {
		existsSync: ((...args: Parameters<typeof actual.existsSync>) => {
			record(args[0]);
			return actual.existsSync(...args);
		}) as typeof actual.existsSync,
		statSync: ((...args: Parameters<typeof actual.statSync>) => {
			record(args[0]);
			return actual.statSync(...args);
		}) as typeof actual.statSync,
		lstatSync: ((...args: Parameters<typeof actual.lstatSync>) => {
			record(args[0]);
			return actual.lstatSync(...args);
		}) as typeof actual.lstatSync,
		readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
			record(args[0]);
			return actual.readdirSync(...args);
		}) as typeof actual.readdirSync,
	};
	return { ...actual, ...patched, default: { ...actual, ...patched } };
});

const DAY_MS = 24 * 60 * 60 * 1000;
const AGENT_DIR_ENV = "ATOMIC_CODING_AGENT_DIR";

const roots: string[] = [];
const savedAgentDirEnv = process.env[AGENT_DIR_ENV];

function makeAgentDirWithStaleArtifacts(prefix: string, sessionName: string): { agentDir: string; staleFile: string } {
	const agentDir = fs.mkdtempSync(join(tmpdir(), prefix));
	roots.push(agentDir);
	const artifactsDir = join(agentDir, "sessions", sessionName, "subagent-artifacts");
	fs.mkdirSync(artifactsDir, { recursive: true });
	const staleFile = join(artifactsDir, "run_worker_output.md");
	fs.writeFileSync(staleFile, "stale\n");
	const old = new Date(Date.now() - 10 * DAY_MS);
	fs.utimesSync(staleFile, old, old);
	return { agentDir, staleFile };
}

function makeState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		subagentInProgress: false,
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
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

function isolatedContext(sessionDir: string): ExtensionContext {
	return {
		sessionManager: {
			usesDefaultSessionDir: () => false,
			getSessionDir: () => sessionDir,
			getSessionFile: () => null,
		},
	} as unknown as ExtensionContext;
}

interface MaintenanceHarness {
	maintenance: ReturnType<typeof createSubagentStartupMaintenance>;
	runStartupScan: () => void;
}

function makeMaintenance(resultsDir: string): MaintenanceHarness {
	const macrotasks: Array<() => void> = [];
	const delayed: Array<() => void> = [];
	const maintenance = createSubagentStartupMaintenance(pi(), makeState(), {
		resultsDir,
		artifactCleanupDays: 1,
		resultTtlMs: 1000,
		scheduleMacrotask: (task) => {
			macrotasks.push(task);
			return () => undefined;
		},
		scheduleDelayed: (task) => {
			delayed.push(task);
			return () => undefined;
		},
	});
	return {
		maintenance,
		runStartupScan: () => {
			for (const task of macrotasks.splice(0)) task();
			pathRecorder.paths.length = 0;
			pathRecorder.active = true;
			try {
				for (const task of delayed.splice(0)) task();
			} finally {
				pathRecorder.active = false;
			}
		},
	};
}

afterEach(() => {
	if (savedAgentDirEnv === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = savedAgentDirEnv;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("agentDir isolation of the global artifact scan", () => {
	test("scans only the context-provided sessions root, never the global roots", () => {
		const globalDir = makeAgentDirWithStaleArtifacts("atomic-isolation-global-", "session-g");
		process.env[AGENT_DIR_ENV] = globalDir.agentDir;
		const isolated = makeAgentDirWithStaleArtifacts("atomic-isolation-agent-", "session-i");
		const sessionDir = join(isolated.agentDir, "sessions", "session-i");

		const { maintenance, runStartupScan } = makeMaintenance(join(isolated.agentDir, "results"));
		try {
			maintenance.scheduleStartupCleanup();
			maintenance.cleanupSessionArtifactsDeferred(isolatedContext(sessionDir));
			runStartupScan();
		} finally {
			maintenance.stop();
		}

		assert.equal(fs.existsSync(isolated.staleFile), false, "the isolated sessions root must be cleaned");
		assert.equal(fs.existsSync(globalDir.staleFile), true, "the global sessions root must stay untouched");
		const globalSessionsRoot = join(globalDir.agentDir, "sessions");
		const touchedGlobal = pathRecorder.paths.filter((touched) => touched.startsWith(globalSessionsRoot));
		assert.deepEqual(touchedGlobal, [], "no fs call may touch a path under the global sessions roots");
	});

	test("falls back to the env/global derivation when the context supplies no isolated root", () => {
		const globalDir = makeAgentDirWithStaleArtifacts("atomic-isolation-global-", "session-g");
		process.env[AGENT_DIR_ENV] = globalDir.agentDir;

		const { maintenance, runStartupScan } = makeMaintenance(join(globalDir.agentDir, "results"));
		try {
			maintenance.scheduleStartupCleanup();
			runStartupScan();
		} finally {
			maintenance.stop();
		}

		assert.equal(
			fs.existsSync(globalDir.staleFile),
			false,
			"without a context root, the env/global roots are scanned",
		);
	});
});
