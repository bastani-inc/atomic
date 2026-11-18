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
const STATUS_TEXT = "Starting Atomic…";
const TRUST_QUESTION = "Trust project folder?";
/** Printed by the shell once atomic exited, so a test sees what atomic left on the screen. */
const EXIT_MARK = "STATUS_PROBE_EXIT=";
const EXTENSION_OUTPUT = "EXTENSION SAYS IT IS LOADING";

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

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * atomic in its own tmux server, in a project folder with a setting and no trust decision, with an extension passed by
 * `-e` that holds startup until the test releases it. `console` makes the extension print a line before it holds;
 * `commandLine` prints the command line above atomic's first row, as a shell does.
 */
function startProbe(options: { pinnedSessionStore: boolean; console?: boolean; commandLine?: boolean }) {
	const root = mkdtempSync(join(tmpdir(), "atomic-startup-status-"));
	tempDirs.push(root);
	const home = join(root, "home");
	const agentDir = join(home, "agent");
	const project = join(root, "project");
	const gate = join(root, "gate");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(project, ".atomic"), { recursive: true });
	mkdirSync(gate, { recursive: true });
	// A project setting with no saved trust decision: startup asks before it loads project resources.
	writeFileSync(join(project, ".atomic", "settings.json"), "{}\n");
	// Command-line extensions load before the question; this one holds startup there until the test says so.
	const extension = join(root, "hold-startup.ts");
	writeFileSync(
		extension,
		[
			'import { existsSync, writeFileSync } from "node:fs";',
			"export default async function () {",
			...(options.console ? [`\tconsole.log(${JSON.stringify(EXTENSION_OUTPUT)});`] : []),
			`\twriteFileSync(${JSON.stringify(join(gate, "loading"))}, "");`,
			`\twhile (!existsSync(${JSON.stringify(join(gate, "release"))})) await new Promise((resolve) => setTimeout(resolve, 25));`,
			"}",
			"",
		].join("\n"),
	);
	const socket = join(root, "tmux.sock");
	const config = join(root, "tmux.conf");
	writeFileSync(config, "set -g remain-on-exit on\n");
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
		// A pinned session store keeps the host isolated in a folder without a trust decision; without one, the
		// extensions load in the interactive process itself.
		...(options.pinnedSessionStore ? [`--session-dir ${quote(join(root, "sessions"))}`] : []),
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
	tmux(
		"new-session",
		"-d",
		"-s",
		"status",
		"-x",
		"100",
		"-y",
		"30",
		"-c",
		project,
		"sh",
		"-c",
		`${options.commandLine ? "echo '$ atomic'; " : ""}${command}; echo ${EXIT_MARK}$?`,
	);
	const waitForScreen = (what: string, timeoutMs: number, matches: (pane: string) => boolean) =>
		waitFor(
			what,
			timeoutMs,
			() => {
				const pane = screen();
				return matches(pane) ? pane : undefined;
			},
			screen,
		);
	return {
		tmux,
		screen,
		waitForScreen,
		waitForLoading: () =>
			waitFor(
				"the extension to start loading",
				STARTUP_TIMEOUT_MS,
				() => (existsSync(join(gate, "loading")) ? true : undefined),
				screen,
			),
		release: () => writeFileSync(join(gate, "release"), ""),
		stop: () => spawnSync("tmux", ["-S", socket, "kill-server"], { timeout: TMUX_COMMAND_TIMEOUT_MS }),
	};
}

it.skipIf(!tmuxAvailable)(
	"shows that it is starting while the isolated host waits for the engine's trust question (#5546)",
	async () => {
		const probe = startProbe({ pinnedSessionStore: true });
		try {
			await probe.waitForLoading();

			// The engine has not asked yet, and the terminal already says that atomic is starting.
			const waiting = await probe.waitForScreen("the startup status", STATUS_TIMEOUT_MS, (pane) =>
				pane.includes(STATUS_TEXT),
			);
			expect(waiting).not.toContain(TRUST_QUESTION);
			expect(waiting.trim()).toBe(STATUS_TEXT);

			probe.release();
			const asked = await probe.waitForScreen("the trust question", STARTUP_TIMEOUT_MS, (pane) =>
				pane.includes(TRUST_QUESTION),
			);
			// The question replaces the status line; nothing is left behind it.
			expect(asked).not.toContain(STATUS_TEXT);
		} finally {
			probe.stop();
		}
	},
	STARTUP_TIMEOUT_MS * 2 + STATUS_TIMEOUT_MS,
);

it.skipIf(!tmuxAvailable)(
	"gives an extension's startup output a line of its own and leaves no status line after /quit (#5546)",
	async () => {
		const probe = startProbe({ pinnedSessionStore: false, console: true });
		try {
			await probe.waitForLoading();
			const printed = await probe.waitForScreen("the extension's output", STATUS_TIMEOUT_MS, (pane) =>
				pane.includes(EXTENSION_OUTPUT),
			);
			// The output takes the row the status line was on; the status line moves below it.
			const rows = printed.split("\n").map((row) => row.trimEnd());
			expect(rows).toContain(EXTENSION_OUTPUT);
			expect(rows).toContain(STATUS_TEXT);

			probe.release();
			await probe.waitForScreen("the trust question", STARTUP_TIMEOUT_MS, (pane) => pane.includes(TRUST_QUESTION));
			// Decline, for this session only, which the question offers first.
			probe.tmux("send-keys", "-t", "status", "Enter");
			await probe.waitForScreen("the prompt", STARTUP_TIMEOUT_MS, (pane) => !pane.includes(TRUST_QUESTION));
			probe.tmux("send-keys", "-t", "status", "-l", "/quit");
			probe.tmux("send-keys", "-t", "status", "Enter");
			const exited = await probe.waitForScreen("atomic to exit", STARTUP_TIMEOUT_MS, (pane) =>
				pane.includes(EXIT_MARK),
			);

			// The extension's output stays in the terminal as it printed it, and the status line is gone.
			expect(exited).toContain(`${EXIT_MARK}0`);
			expect(exited.split("\n").map((row) => row.trimEnd())).toContain(EXTENSION_OUTPUT);
			expect(exited).not.toContain("Starting");
		} finally {
			probe.stop();
		}
	},
	STARTUP_TIMEOUT_MS * 4 + STATUS_TIMEOUT_MS,
);

it.skipIf(!tmuxAvailable)(
	"leaves no part of the status line behind when the terminal narrows and startup is cancelled (#5546)",
	async () => {
		// Started from a shell, so a row is above the line. On a pane's top row instead, a narrower tmux moves the
		// first row of the wrapped line into its scrollback itself, where no program can erase it.
		const probe = startProbe({ pinnedSessionStore: true, commandLine: true });
		try {
			await probe.waitForLoading();
			await probe.waitForScreen("the startup status", STATUS_TIMEOUT_MS, (pane) => pane.includes(STATUS_TEXT));

			// Narrower than the line: the terminal wraps what it shows onto more rows.
			probe.tmux("resize-window", "-t", "status", "-x", "8", "-y", "30");
			const narrow = await probe
				.waitForScreen("the status to fit the narrow terminal", STATUS_TIMEOUT_MS, (pane) =>
					pane.includes("Starti…"),
				)
				.catch(() => probe.screen());

			probe.tmux("send-keys", "-t", "status", "C-c");
			const exited = await probe.waitForScreen("atomic to exit", STARTUP_TIMEOUT_MS, (pane) =>
				pane.includes(EXIT_MARK),
			);
			expect(exited).toContain(`${EXIT_MARK}130`);
			expect(exited).not.toMatch(/Start|tarti|Atomic|…/);
			// While it waited, the line was drawn again to fit one row of the narrower terminal.
			expect(narrow.split("\n").map((row) => row.trimEnd())).toContain("Starti…");
		} finally {
			probe.stop();
		}
	},
	STARTUP_TIMEOUT_MS * 2 + STATUS_TIMEOUT_MS * 2,
);
