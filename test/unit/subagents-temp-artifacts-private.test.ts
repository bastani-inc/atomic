import assert from "node:assert/strict";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { afterAll, afterEach, beforeEach, test } from "vitest";
import { resetSessionTempDirStateForTesting } from "../../packages/coding-agent/src/core/tools/session-temp-dir.ts";
import {
	readWindowsDirectorySecurity,
	setWindowsDirectorySecurityReaderForTesting,
} from "../../packages/coding-agent/src/core/tools/windows-directory-security.ts";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type { ExecutorDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { cleanupAllArtifactDirs, getArtifactsDir } from "../../packages/subagents/src/shared/artifacts.js";
import type { RunSyncOptions, SingleResult } from "../../packages/subagents/src/shared/types.js";

/** A launch that reads one real PowerShell descriptor: each attempt is bounded by 30 s, and a loaded host takes them all. */
const REAL_DESCRIPTOR_READ_LAUNCH_TIMEOUT_MS = 90_000;
const REAL_DESCRIPTOR_READ_SETTLED_MS = REAL_DESCRIPTOR_READ_LAUNCH_TIMEOUT_MS - 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const envKeys = ["TMPDIR", "TEMP", "TMP", "XDG_RUNTIME_DIR", "ATOMIC_CODING_AGENT_DIR"] as const;
const savedEnv = new Map<string, string | undefined>(envKeys.map((key) => [key, process.env[key]]));
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "atomic-subagents-private-")));
let agentDir = "";

beforeEach(() => {
	// Stand-ins for the shared temp directory and this account's agent directory; no runtime directory.
	const scratch = mkdtempSync(join(sandbox, "case-"));
	for (const key of ["TMPDIR", "TEMP", "TMP"]) process.env[key] = scratch;
	agentDir = join(scratch, "home", "agent");
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	delete process.env.XDG_RUNTIME_DIR;
	resetSessionTempDirStateForTesting();
});

afterEach(() => {
	setWindowsDirectorySecurityReaderForTesting(undefined);
});

afterAll(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	resetSessionTempDirStateForTesting();
	rmSync(sandbox, { recursive: true, force: true });
});

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
}

test.skipIf(process.platform === "win32")(
	"session-less subagent artifacts use a directory only the current user owns",
	() => {
		const dir = getArtifactsDir(null);

		assert.ok(isInside(agentDir, dir), `${dir} is inside the account's agent directory`);
		for (let current = dir; isInside(join(agentDir, "cache"), current); current = dirname(current)) {
			const stat = lstatSync(current);
			assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), current);
			assert.equal(stat.uid, process.getuid!(), current);
			assert.equal(stat.mode & 0o077, 0, `${current} has no group or other access`);
		}
	},
);

test.skipIf(process.platform === "win32")(
	"a symbolic link planted at the session-less artifact directory is not followed",
	() => {
		const elsewhere = join(sandbox, `planted-${Date.now()}`);
		mkdirSync(elsewhere, { mode: 0o700 });
		mkdirSync(join(agentDir, "cache", "tmp", "subagents"), { recursive: true, mode: 0o700 });
		symlinkSync(elsewhere, join(agentDir, "cache", "tmp", "subagents", "artifacts"), "dir");

		const dir = getArtifactsDir(null);

		assert.ok(!isInside(join(agentDir, "cache"), dir), `${dir} avoids the planted link`);
		assert.ok(lstatSync(dir).isDirectory());
		assert.deepEqual(readdirSync(elsewhere), [], "nothing is created through the planted link");
	},
);

test.skipIf(process.platform !== "win32")(
	"a subagent launched from an in-memory session reads its artifact directory's descriptor without holding the event loop (#5324)",
	async () => {
		const heldReads: string[] = [];
		setWindowsDirectorySecurityReaderForTesting((path) => {
			heldReads.push(path);
			return readWindowsDirectorySecurity(path);
		});
		const cwd = join(dirname(agentDir), "project");
		mkdirSync(cwd, { recursive: true });
		const launchedArtifactDirs: (string | undefined)[] = [];
		const executor = createSubagentExecutor({
			pi: {
				events: { on: () => () => {}, emit: () => {} },
				getSessionName: () => "parent",
			} as unknown as ExecutorDeps["pi"],
			state: {
				baseCwd: "",
				currentSessionId: null,
				foregroundControls: new Map(),
				lastForegroundControlId: null,
				pendingForegroundControlNotices: new Map(),
				lastUiContext: null,
			},
			config: { intercomBridge: { mode: "off" }, parallel: { concurrency: 4, maxTasks: 50 } },
			tempArtifactsDir: join(cwd, "unused-artifacts"),
			getSubagentSessionRoot: () => join(cwd, "sessions"),
			expandTilde: (value) => value,
			discoverAgents: () => ({
				agents: [
					{
						name: "worker",
						description: "Inspect a patch",
						systemPrompt: "Self-contained task: review only",
						systemPromptMode: "replace",
						inheritProjectContext: false,
						inheritSkills: false,
						source: "project",
						filePath: join(cwd, "worker.md"),
					},
				],
			}),
			runtime: {
				runSync: async (
					_cwd: string,
					_agents: unknown,
					agent: string,
					task: string,
					options: RunSyncOptions,
				): Promise<SingleResult> => {
					launchedArtifactDirs.push(options.artifactsDir);
					return {
						agent,
						task,
						status: "ok",
						messages: [],
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
						finalOutput: "done",
					};
				},
			},
		});
		const ctx = {
			cwd,
			mode: "tui",
			hasUI: false,
			model: undefined,
			modelRegistry: { getAvailable: () => [] },
			sessionManager: {
				getSessionFile: () => undefined,
				getSessionId: () => "parent",
				getLeafId: () => null,
				getEntries: () => [],
			},
			isProjectTrusted: () => true,
		} as unknown as ExtensionContext;

		const result = await executor.execute(
			"in-memory-launch",
			{ agent: "worker", task: "Inspect the patch" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.notEqual(result.isError, true, JSON.stringify(result.content));
		assert.deepEqual(heldReads, [], "the launch read no descriptor on the main thread");
		assert.deepEqual(launchedArtifactDirs, [getArtifactsDir(null)], "the child writes into the verified directory");
	},
	REAL_DESCRIPTOR_READ_LAUNCH_TIMEOUT_MS,
);

test.skipIf(process.platform !== "win32")(
	"the deferred artifact scan reads the session-less directory's descriptor without holding the event loop (#5324)",
	async () => {
		const stale = join(agentDir, "cache", "tmp", "subagents", "artifacts", "run_worker_output.md");
		mkdirSync(dirname(stale), { recursive: true });
		writeFileSync(stale, "stale\n");
		const old = new Date(Date.now() - 10 * DAY_MS);
		utimesSync(stale, old, old);
		const heldReads: string[] = [];
		setWindowsDirectorySecurityReaderForTesting((path) => {
			heldReads.push(path);
			return readWindowsDirectorySecurity(path);
		});

		cleanupAllArtifactDirs(1, []);
		const deadline = Date.now() + REAL_DESCRIPTOR_READ_SETTLED_MS;
		while (existsSync(stale) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));

		assert.deepEqual(heldReads, [], "the scan read no descriptor on the main thread");
		assert.equal(existsSync(stale), false, "the scan removed the stale session-less artifact");
	},
	REAL_DESCRIPTOR_READ_LAUNCH_TIMEOUT_MS,
);
