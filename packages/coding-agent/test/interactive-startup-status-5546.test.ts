import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bunExecutable, cliPath, removeTempDirs } from "./cli-test-helpers.ts";

/** A tmux command answers at once; a hung one fails the test by name instead of blocking the worker. */
const TMUX_COMMAND_TIMEOUT_MS = 10_000;
/** A real host and engine start from source; a loaded runner needs headroom. */
const STARTUP_TIMEOUT_MS = 90_000;
/** Once the engine is loading, the host has long since drawn its status; the wait only covers tmux catching up. */
const STATUS_TIMEOUT_MS = 15_000;
const STATUS_TEXT = "Starting atomic…";
const TRUST_QUESTION = "Trust project folder?";

const tmuxAvailable =
	process.platform !== "win32" && spawnSync("tmux", ["-V"], { timeout: TMUX_COMMAND_TIMEOUT_MS }).status === 0;
const tempDirs: string[] = [];

afterEach(() => removeTempDirs(tempDirs));

async function waitFor<T>(what: string, timeoutMs: number, probe: () => T | undefined, describe: () => string) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. Screen:\n${describe()}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

it.skipIf(!tmuxAvailable)(
	"shows that it is starting while the isolated host waits for the engine's trust question (#5546)",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-startup-status-"));
		tempDirs.push(root);
		const home = join(root, "home");
		const agentDir = join(home, "agent");
		const project = join(root, "project");
		const gate = join(root, "gate");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(project, ".atomic"), { recursive: true });
		mkdirSync(gate, { recursive: true });
		// A project setting with no saved trust decision: the engine asks before it loads project resources.
		writeFileSync(join(project, ".atomic", "settings.json"), "{}\n");
		// The engine loads command-line extensions before it asks; this one holds it there until the test says so.
		const extension = join(root, "hold-engine.ts");
		writeFileSync(
			extension,
			[
				'import { existsSync, writeFileSync } from "node:fs";',
				"export default async function () {",
				`\twriteFileSync(${JSON.stringify(join(gate, "engine-loading"))}, "");`,
				`\twhile (!existsSync(${JSON.stringify(join(gate, "release"))})) await new Promise((resolve) => setTimeout(resolve, 25));`,
				"}",
				"",
			].join("\n"),
		);
		const socket = join(root, "tmux.sock");
		const config = join(root, "tmux.conf");
		writeFileSync(config, "set -g remain-on-exit on\n");
		const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
		const env = {
			HOME: home,
			USERPROFILE: home,
			PATH: process.env.PATH ?? "",
			TERM: "xterm-256color",
			ATOMIC_CODING_AGENT_DIR: agentDir,
			ATOMIC_SKIP_VERSION_CHECK: "1",
			ATOMIC_TELEMETRY: "0",
		};
		const command = [
			"env -i",
			...Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`),
			quote(bunExecutable()),
			quote(cliPath),
			"--offline --no-mcp",
			// A pinned session store keeps the host isolated in a folder without a trust decision.
			`--session-dir ${quote(join(root, "sessions"))}`,
			`-e ${quote(extension)}`,
			"--append-system-prompt 'startup status probe'",
		].join(" ");
		const tmux = (...args: string[]) => {
			const result = spawnSync("tmux", ["-S", socket, "-f", config, ...args], {
				encoding: "utf8",
				timeout: TMUX_COMMAND_TIMEOUT_MS,
			});
			expect(result.status, result.stderr).toBe(0);
			return result.stdout;
		};
		const screen = () => tmux("capture-pane", "-p", "-J", "-S", "-", "-t", "status");
		try {
			tmux("new-session", "-d", "-s", "status", "-x", "100", "-y", "30", "-c", project, "sh", "-c", command);
			await waitFor(
				"the engine to start loading",
				STARTUP_TIMEOUT_MS,
				() => (existsSync(join(gate, "engine-loading")) ? true : undefined),
				screen,
			);

			// The engine has not asked yet, and the terminal already says that atomic is starting.
			const waiting = await waitFor(
				"the startup status",
				STATUS_TIMEOUT_MS,
				() => {
					const pane = screen();
					return pane.includes(STATUS_TEXT) ? pane : undefined;
				},
				screen,
			);
			expect(waiting).not.toContain(TRUST_QUESTION);
			expect(waiting.trim()).toBe(STATUS_TEXT);

			writeFileSync(join(gate, "release"), "");
			const asked = await waitFor(
				"the trust question",
				STARTUP_TIMEOUT_MS,
				() => {
					const pane = screen();
					return pane.includes(TRUST_QUESTION) ? pane : undefined;
				},
				screen,
			);
			// The question replaces the status line; nothing is left behind it.
			expect(asked).not.toContain(STATUS_TEXT);
		} finally {
			spawnSync("tmux", ["-S", socket, "kill-server"], { timeout: TMUX_COMMAND_TIMEOUT_MS });
		}
	},
	STARTUP_TIMEOUT_MS * 2 + STATUS_TIMEOUT_MS,
);
