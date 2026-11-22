import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { afterAll, beforeEach, test, vi } from "vitest";
import { resetSessionTempDirStateForTesting } from "../../packages/coding-agent/src/core/tools/session-temp-dir.ts";
import registerSubagentExtension from "../../packages/subagents/src/extension/index.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type { ExecutorDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { getArtifactsDir } from "../../packages/subagents/src/shared/artifacts.js";
import type { RunSyncOptions, SingleResult } from "../../packages/subagents/src/shared/types.js";

const spawned = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	spawned.spawn.mockImplementation(actual.spawn);
	spawned.spawnSync.mockImplementation(actual.spawnSync);
	return { ...actual, spawn: spawned.spawn, spawnSync: spawned.spawnSync };
});

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
	async () => {
		const dir = await getArtifactsDir(null);

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
	async () => {
		const elsewhere = join(sandbox, `planted-${Date.now()}`);
		mkdirSync(elsewhere, { mode: 0o700 });
		mkdirSync(join(agentDir, "cache", "tmp", "subagents"), { recursive: true, mode: 0o700 });
		symlinkSync(elsewhere, join(agentDir, "cache", "tmp", "subagents", "artifacts"), "dir");

		const dir = await getArtifactsDir(null);

		assert.ok(!isInside(join(agentDir, "cache"), dir), `${dir} avoids the planted link`);
		assert.ok(lstatSync(dir).isDirectory());
		assert.deepEqual(readdirSync(elsewhere), [], "nothing is created through the planted link");
	},
);

test("registering the subagent extension leaves the session-less artifact directory to the first launch that needs it (#5324)", () => {
	const atomic = {
		events: { on: () => () => {}, emit: () => {} },
		registerTool: () => {},
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		on: () => {},
		sendMessage: () => {},
	} as unknown as ExtensionAPI;

	registerSubagentExtension(atomic);

	assert.equal(existsSync(join(agentDir, "cache", "tmp", "subagents")), false);
});

test.skipIf(process.platform !== "win32")(
	"a subagent launched from an in-memory session verifies its artifact directory without starting PowerShell on the main thread (#5324)",
	async () => {
		spawned.spawn.mockClear();
		spawned.spawnSync.mockClear();
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
		assert.deepEqual(
			[...spawned.spawn.mock.calls, ...spawned.spawnSync.mock.calls]
				.map(([command]) => String(command))
				.filter((command) => /powershell|pwsh/i.test(command)),
			[],
			"the native reader needed no PowerShell process",
		);
		assert.deepEqual(
			launchedArtifactDirs,
			[await getArtifactsDir(null)],
			"the child writes into the verified directory",
		);
	},
);
