import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { fileExists, moduleDir, sleep, spawnSyncCollect, writeFileEnsuringDir } from "../helpers/runtime.js";

const repoRoot = join(moduleDir(import.meta.url), "../..");
const TMUX_AVAILABLE = (() => {
	try {
		return spawnSyncCollect(["tmux", "-V"]).exitCode === 0;
	} catch {
		return false;
	}
})();
const REAL_INTERACTIVE_COMMAND_TIMEOUT_MS = 120_000;
const ENGINE_STARTUP_BUDGET_MS = 45_000;
const COMMAND_RENDER_BUDGET_MS = 30_000;

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
		try {
			tmux(
				"new-session",
				"-d",
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
			);
			const startupDeadline = Date.now() + ENGINE_STARTUP_BUDGET_MS;
			while (!(await fileExists(ready)) && Date.now() < startupDeadline) await sleep(50);
			assert.ok(await fileExists(ready), pane());
			submit("/reload");
			const reloadDeadline = Date.now() + COMMAND_RENDER_BUDGET_MS;
			while (!pane().includes("Reloaded keybindings") && Date.now() < reloadDeadline) await sleep(50);
			assert.ok(pane().includes("Reloaded keybindings"), pane());
			submit("/workflow status");
			const renderDeadline = Date.now() + COMMAND_RENDER_BUDGET_MS;
			while (!pane().includes("no workflow runs in current session") && Date.now() < renderDeadline) await sleep(50);
			assert.ok(pane().includes("no workflow runs in current session"), pane());
		} finally {
			spawnSyncCollect(["tmux", "-S", socket, "kill-server"]);
			rmSync(temp, { recursive: true, force: true });
		}
	},
	REAL_INTERACTIVE_COMMAND_TIMEOUT_MS,
);
