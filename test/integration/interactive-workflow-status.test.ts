import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { removeFixtureTree } from "../helpers/fixture-removal.js";
import { signalUnlessExited } from "../helpers/process-signal.js";
import { fileExists, moduleDir, sleep, spawnSyncCollect, writeFileEnsuringDir } from "../helpers/runtime.js";

const repoRoot = join(moduleDir(import.meta.url), "../..");
const TMUX_AVAILABLE = (() => {
	try {
		return spawnSyncCollect(["tmux", "-V"]).exitCode === 0;
	} catch {
		return false;
	}
})();
/**
 * Starting the CLI and its isolated engine compiles every bundled extension through jiti: about 10 s on an idle
 * machine, and more than 45 s when the runner is oversubscribed (#4706).
 */
const ENGINE_STARTUP_BUDGET_MS = 120_000;
const COMMAND_RENDER_BUDGET_MS = 30_000;
/**
 * How long the CLI and its detached engine may take to exit once the tmux server closes their terminal. The engine
 * runs its session shutdown under a grace period of its own before its guardian steps in, and keeps writing its jiti
 * cache under the temporary home until it has exited (#4706).
 */
const PROCESS_EXIT_BUDGET_MS = 30_000;
const TEARDOWN_OVERHEAD_MS = 10_000;
/** A real CLI and engine in tmux: startup, two commands, then waiting for exit and, failing that, for a forced exit. */
const REAL_INTERACTIVE_COMMAND_TIMEOUT_MS =
	ENGINE_STARTUP_BUDGET_MS + 2 * COMMAND_RENDER_BUDGET_MS + 2 * PROCESS_EXIT_BUDGET_MS + TEARDOWN_OVERHEAD_MS;
const POLL_INTERVAL_MS = 50;

/** The process groups of `root` and of every process under it; the isolated engine starts a group of its own. */
function processGroupsUnder(root: number): number[] {
	const rows = spawnSyncCollect(["ps", "-A", "-o", "pid=,ppid=,pgid="])
		.stdout.toString()
		.trim()
		.split("\n")
		.map((line) => line.trim().split(/\s+/).map(Number));
	const tree = new Set([root]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const [pid, ppid] of rows) {
			if (tree.has(ppid) && !tree.has(pid)) {
				tree.add(pid);
				grew = true;
			}
		}
	}
	return [...new Set(rows.filter(([pid, , pgid]) => tree.has(pid) && pgid > 1).map(([, , pgid]) => pgid))];
}

const groupAlive = (pgid: number) => signalUnlessExited(-pgid, 0) === "signalled";

async function waitForGroupsToExit(groups: readonly number[], budgetMs: number): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (groups.some(groupAlive) && Date.now() < deadline) await sleep(POLL_INTERVAL_MS);
}

test.skipIf(!TMUX_AVAILABLE)(
	"idle workflow status renders live through the isolated engine after reload (#3468)",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-workflow-status-"));
		const socket = join(temp, "tmux.sock");
		const agent = join(temp, "agent");
		const observer = join(temp, "observer.mjs");
		const ready = join(temp, "ready");
		mkdirSync(join(agent, "extensions/workflow"), { recursive: true });
		await writeFileEnsuringDir(join(agent, "extensions/workflow/config.json"), '{"resumeInFlight":"never"}');
		await writeFileEnsuringDir(
			observer,
			`import { writeFileSync } from "node:fs";
export default pi => pi.on("session_start", (_event, ctx) => {
 if (!ctx.isPresentationOnly) writeFileSync(${JSON.stringify(ready)}, "ready");
});
`,
		);
		const tmux = (...args: string[]) => {
			const result = spawnSyncCollect(["tmux", "-S", socket, ...args]);
			assert.equal(result.exitCode, 0, result.stderr.toString());
			return result.stdout.toString();
		};
		const pane = () => tmux("capture-pane", "-p", "-S", "-", "-t", "status");
		const submit = (text: string) => {
			tmux("send-keys", "-t", "status", "-l", text);
			tmux("send-keys", "-t", "status", "Enter");
		};
		let panePid: number | undefined;
		try {
			const started = tmux(
				"new-session",
				"-d",
				"-P",
				"-F",
				"#{pane_pid}",
				"-s",
				"status",
				"-x",
				"120",
				"-y",
				"40",
				"-c",
				temp,
				"-e",
				`ATOMIC_CODING_AGENT_DIR=${agent}`,
				process.execPath,
				join(repoRoot, "packages/coding-agent/dist/cli.js"),
				"--no-session",
				"--offline",
				"--approve",
				"--no-skills",
				"--no-prompt-templates",
				"--no-context-files",
				"--no-mcp",
				"--extension",
				observer,
				";",
				"set-option",
				"-t",
				"status",
				"remain-on-exit",
				"on",
			);
			panePid = Number(started.trim());
			const startupDeadline = Date.now() + ENGINE_STARTUP_BUDGET_MS;
			while (!(await fileExists(ready)) && Date.now() < startupDeadline) await sleep(POLL_INTERVAL_MS);
			assert.ok(
				await fileExists(ready),
				`The CLI did not start its engine within ${ENGINE_STARTUP_BUDGET_MS} ms. Pane:\n${pane()}`,
			);
			submit("/reload");
			const reloadDeadline = Date.now() + COMMAND_RENDER_BUDGET_MS;
			while (!pane().includes("Reloaded keybindings") && Date.now() < reloadDeadline) await sleep(POLL_INTERVAL_MS);
			assert.ok(pane().includes("Reloaded keybindings"), pane());
			submit("/workflow status");
			const renderDeadline = Date.now() + COMMAND_RENDER_BUDGET_MS;
			while (!pane().includes("no workflow runs in current session") && Date.now() < renderDeadline) {
				await sleep(POLL_INTERVAL_MS);
			}
			assert.ok(pane().includes("no workflow runs in current session"), pane());
		} finally {
			const groups = panePid === undefined ? [] : processGroupsUnder(panePid);
			spawnSyncCollect(["tmux", "-S", socket, "kill-server"]);
			await waitForGroupsToExit(groups, PROCESS_EXIT_BUDGET_MS);
			for (const pgid of groups.filter(groupAlive)) signalUnlessExited(-pgid, "SIGKILL");
			await waitForGroupsToExit(groups, PROCESS_EXIT_BUDGET_MS);
			removeFixtureTree(temp);
		}
	},
	REAL_INTERACTIVE_COMMAND_TIMEOUT_MS,
);
