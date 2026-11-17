import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { afterEach, describe, test, vi } from "vitest";
import { createSubagentStartupMaintenance } from "../../packages/subagents/src/extension/startup-maintenance.ts";
import type { SubagentState } from "../../packages/subagents/src/shared/types.ts";

const pathRecorder = vi.hoisted(() => ({ active: false, paths: [] as string[] }));

// Record every path handed to the fs probes the artifact scan uses, so the test
// can prove the global sessions roots are never touched with an isolated agentDir.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const record = (target: fs.PathLike): void => {
		if (pathRecorder.active) pathRecorder.paths.push(String(target));
	};
	const patched = {
		access: ((...args: Parameters<typeof actual.access>) => {
			record(args[0]);
			return actual.access(...args);
		}) as typeof actual.access,
		stat: ((...args: Parameters<typeof actual.stat>) => {
			record(args[0]);
			return actual.stat(...args);
		}) as typeof actual.stat,
		lstat: ((...args: Parameters<typeof actual.lstat>) => {
			record(args[0]);
			return actual.lstat(...args);
		}) as typeof actual.lstat,
		readdir: ((...args: Parameters<typeof actual.readdir>) => {
			record(args[0]);
			return actual.readdir(...args);
		}) as typeof actual.readdir,
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

const CWD = process.cwd();
const SAFE_CWD = `--${CWD.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

function isolatedContext(sessionDir: string): ExtensionContext {
	return {
		cwd: CWD,
		sessionManager: {
			usesDefaultSessionDir: () => false,
			getSessionDir: () => sessionDir,
			getSessionFile: () => null,
		},
	} as unknown as ExtensionContext;
}

interface MaintenanceHarness {
	maintenance: ReturnType<typeof createSubagentStartupMaintenance>;
	runStartupScan: () => Promise<void>;
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
	const completed = Promise.withResolvers<void>();
	return {
		maintenance: {
			...maintenance,
			scheduleStartupCleanup: (onDone) =>
				maintenance.scheduleStartupCleanup(() => {
					onDone?.();
					completed.resolve();
				}),
		},
		runStartupScan: async () => {
			for (const task of macrotasks.splice(0)) task();
			pathRecorder.paths.length = 0;
			pathRecorder.active = true;
			try {
				for (const task of delayed.splice(0)) task();
				await completed.promise;
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
	test("scans only the context-provided sessions root, never the global roots", async () => {
		const globalDir = makeAgentDirWithStaleArtifacts("atomic-isolation-global-", "session-g");
		process.env[AGENT_DIR_ENV] = globalDir.agentDir;
		const isolated = makeAgentDirWithStaleArtifacts("atomic-isolation-agent-", SAFE_CWD);
		const sessionDir = join(isolated.agentDir, "sessions", SAFE_CWD);

		const { maintenance, runStartupScan } = makeMaintenance(join(isolated.agentDir, "results"));
		try {
			maintenance.scheduleStartupCleanup();
			maintenance.cleanupSessionArtifactsDeferred(isolatedContext(sessionDir));
			await runStartupScan();
		} finally {
			maintenance.stop();
		}

		assert.equal(fs.existsSync(isolated.staleFile), false, "the isolated sessions root must be cleaned");
		assert.equal(fs.existsSync(globalDir.staleFile), true, "the global sessions root must stay untouched");
		const globalSessionsRoot = join(globalDir.agentDir, "sessions");
		const touchedGlobal = pathRecorder.paths.filter((touched) => touched.startsWith(globalSessionsRoot));
		assert.deepEqual(touchedGlobal, [], "no fs call may touch a path under the global sessions roots");
	});

	test("a custom standalone session dir never broadens cleanup into its parent's siblings", async () => {
		const globalDir = makeAgentDirWithStaleArtifacts("atomic-isolation-global-", "session-g");
		process.env[AGENT_DIR_ENV] = globalDir.agentDir;
		const parent = fs.mkdtempSync(join(tmpdir(), "atomic-isolation-custom-"));
		roots.push(parent);
		// An arbitrary parent deliberately named "sessions" must not be trusted either:
		// only the full <agentDir>/sessions/<safe-cwd> layout counts.
		for (const customName of ["my-sessions", join("sessions", "custom-dir")]) {
			const customSessionDir = join(parent, customName);
			fs.mkdirSync(customSessionDir, { recursive: true });
			const siblingRoot = dirname(customSessionDir);
			const siblingArtifacts = join(siblingRoot, `sibling-${basename(customName)}`, "subagent-artifacts");
			fs.mkdirSync(siblingArtifacts, { recursive: true });
			const siblingStale = join(siblingArtifacts, "run_worker_output.md");
			fs.writeFileSync(siblingStale, "stale\n");
			const old = new Date(Date.now() - 10 * DAY_MS);
			fs.utimesSync(siblingStale, old, old);

			const { maintenance, runStartupScan } = makeMaintenance(join(parent, "results"));
			try {
				maintenance.scheduleStartupCleanup();
				maintenance.cleanupSessionArtifactsDeferred(isolatedContext(customSessionDir));
				await runStartupScan();
			} finally {
				maintenance.stop();
			}

			assert.equal(fs.existsSync(siblingStale), true, "siblings of a custom session dir must stay untouched");
			assert.equal(
				fs.existsSync(join(siblingRoot, ".last-cleanup")),
				false,
				"no marker may be written into the parent",
			);
			assert.equal(fs.existsSync(globalDir.staleFile), true, "the global sessions root must stay untouched");
		}
	});

	test("a later default-session context resets the root back to the env/global derivation", async () => {
		const globalDir = makeAgentDirWithStaleArtifacts("atomic-isolation-global-", "session-g");
		process.env[AGENT_DIR_ENV] = globalDir.agentDir;
		const isolated = makeAgentDirWithStaleArtifacts("atomic-isolation-agent-", SAFE_CWD);
		const sessionDir = join(isolated.agentDir, "sessions", SAFE_CWD);
		const defaultContext = {
			cwd: CWD,
			sessionManager: {
				usesDefaultSessionDir: () => true,
				getSessionDir: () => join(globalDir.agentDir, "sessions", "session-g"),
				getSessionFile: () => null,
			},
		} as unknown as ExtensionContext;

		const { maintenance, runStartupScan } = makeMaintenance(join(globalDir.agentDir, "results"));
		try {
			maintenance.scheduleStartupCleanup();
			maintenance.cleanupSessionArtifactsDeferred(isolatedContext(sessionDir));
			maintenance.cleanupSessionArtifactsDeferred(defaultContext);
			await runStartupScan();
		} finally {
			maintenance.stop();
		}

		assert.equal(
			fs.existsSync(globalDir.staleFile),
			false,
			"a default-session context must clear the isolated override so global roots are scanned",
		);
	});

	test("falls back to the env/global derivation when the context supplies no isolated root", async () => {
		const globalDir = makeAgentDirWithStaleArtifacts("atomic-isolation-global-", "session-g");
		process.env[AGENT_DIR_ENV] = globalDir.agentDir;

		const { maintenance, runStartupScan } = makeMaintenance(join(globalDir.agentDir, "results"));
		try {
			maintenance.scheduleStartupCleanup();
			await runStartupScan();
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
