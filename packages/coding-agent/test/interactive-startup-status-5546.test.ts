import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { bunExecutable, cliPath, removeTempDirs } from "./cli-test-helpers.ts";

/** A tmux command answers at once; a hung one fails the test by name instead of blocking the worker. */
const TMUX_COMMAND_TIMEOUT_MS = 10_000;
/** A real host and engine start from source; a loaded runner needs headroom. */
const STARTUP_TIMEOUT_MS = 90_000;
/** Once the engine is loading, the host has long since drawn its status; the wait only covers tmux catching up. */
const STATUS_TIMEOUT_MS = 15_000;
const STATUS_TEXT = "Starting Atomic…";
const TRUST_QUESTION = "Trust project folder?";
/** Printed by the shell on a row of its own once the program exited, so a test sees what it left on the screen. */
const EXIT_MARK = "STATUS_PROBE_EXIT=";
const EXTENSION_OUTPUT = "EXTENSION SAYS IT IS LOADING";
/** Wide characters and a combining mark, which take a different number of cells than characters. */
const WIDE_TEXT = "界面: e\u0301";
const ENTER_ALT_SCREEN = "\x1b[?1049h";
/** The prompt of the interface's composer. */
const INTERFACE_PROMPT = "❯";
const sourceDir = resolve(cliPath, "..");
/** The built CLI, which runs under Node; CI builds the package before its tests. */
const builtCliPath = resolve(sourceDir, "..", "dist", "cli.js");
const builtCliAvailable = existsSync(builtCliPath);
/**
 * Loaded before atomic: holds the process, without letting it run anything else, from when it starts handing the
 * terminal from the status line to the interface's first frame until the test creates `painted`.
 */
const HOLD_FIRST_PAINT = `const { existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const gate = process.env.STATUS_PROBE_GATE;
if (gate && process.stdout.isTTY) {
	const stream = process.stdout;
	let current = stream.write;
	let held = false;
	Object.defineProperty(stream, "write", {
		configurable: true,
		get: () => current,
		set(next) {
			current = next;
			if (held || !/replaceStartupStatus/.test(new Error().stack ?? "")) return;
			held = true;
			writeFileSync(join(gate, "painting"), "");
			const deadline = Date.now() + 60000;
			while (!existsSync(join(gate, "painted")) && Date.now() < deadline)
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		},
	});
}
`;

const tmuxAvailable =
	process.platform !== "win32" && spawnSync("tmux", ["-V"], { timeout: TMUX_COMMAND_TIMEOUT_MS }).status === 0;
/** Recording the write calls a runtime makes needs strace and the right to trace a child. */
const straceAvailable =
	tmuxAvailable && spawnSync("strace", ["-qq", "-o", "/dev/null", "true"], { timeout: 10_000 }).status === 0;
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
const rowsOf = (screen: string) => screen.split("\n").map((row) => row.trimEnd());

/**
 * Every row that shows any part of the status line. Whatever else happens, a row may only ever hold the whole line:
 * never a piece of it, and never the line together with someone else's output.
 */
function statusRows(screen: string): string[] {
	return rowsOf(screen).filter((row) => {
		const text = row.trim();
		return row.includes("Starting") || row.includes("Atomic…") || (text.length >= 3 && STATUS_TEXT.includes(text));
	});
}

interface ProbeOptions {
	/** A pinned session store keeps the host isolated in a folder without a trust decision; without one, the
	 * extensions load in the interactive process itself. */
	readonly host: "isolated" | "in-process";
	/** A saved trust decision for the project, so startup asks nothing and goes straight to the interface. */
	readonly trusted?: boolean;
	/** Statements the `-e` extension runs before it holds startup (it can use `spawnSync` and `writeFileSync`). */
	readonly extension?: readonly string[];
	/** Print a command line above atomic's first row, as a shell does. */
	readonly commandLine?: boolean;
	/** Record the host's write calls into this file. */
	readonly strace?: string;
	/** Run this script with the runtime instead of atomic; `$SRC` is the source folder, `$HOLD` holds until released. */
	readonly script?: string;
	/** Startup is not held. */
	readonly released?: boolean;
	/** The runtime atomic runs on: Bun runs the source, Node the built package. */
	readonly runtime?: "Bun" | "Node";
	/** Printed without ending its row right before atomic starts, as a launcher script reporting something may. */
	readonly launcher?: string;
	/** Hold the host while it hands the terminal to the interface's first frame, until `releasePaint`. */
	readonly holdFirstPaint?: boolean;
}

/**
 * atomic in its own tmux server, in a project folder with a setting, with an extension passed by `-e` that holds startup
 * until the test releases it.
 */
function startProbe(options: ProbeOptions) {
	const root = mkdtempSync(join(tmpdir(), "atomic-startup-status-"));
	tempDirs.push(root);
	const home = join(root, "home");
	const agentDir = join(home, "agent");
	const project = join(root, "project");
	const gate = join(root, "gate");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(project, ".atomic"), { recursive: true });
	mkdirSync(gate, { recursive: true });
	if (options.released) writeFileSync(join(gate, "release"), "");
	// A project setting: without a saved trust decision, startup asks before it loads project resources.
	writeFileSync(join(project, ".atomic", "settings.json"), "{}\n");
	if (options.trusted) writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [realpathSync(project)]: true }));
	const holdUntilReleased = [
		`writeFileSync(${JSON.stringify(join(gate, "loading"))}, "");`,
		`while (!existsSync(${JSON.stringify(join(gate, "release"))})) await new Promise((resolve) => setTimeout(resolve, 25));`,
	];
	// Command-line extensions load before the question; this one holds startup there until the test says so.
	const extension = join(root, "hold-startup.ts");
	writeFileSync(
		extension,
		[
			'import { spawnSync } from "node:child_process";',
			'import { existsSync, writeFileSync } from "node:fs";',
			"export default async function () {",
			...(options.extension ?? []).map((line) => `\t${line}`),
			...holdUntilReleased.map((line) => `\t${line}`),
			"}",
			"",
		].join("\n"),
	);
	const script = join(root, "script.ts");
	if (options.script !== undefined) {
		writeFileSync(
			script,
			[
				'import { existsSync, writeFileSync } from "node:fs";',
				options.script.replaceAll("$SRC", sourceDir).replace("$HOLD", holdUntilReleased.join("\n")),
				"",
			].join("\n"),
		);
	}
	const socket = join(root, "tmux.sock");
	const config = join(root, "tmux.conf");
	writeFileSync(config, "set -g remain-on-exit on\n");
	const holdFirstPaint = join(root, "hold-first-paint.cjs");
	writeFileSync(holdFirstPaint, HOLD_FIRST_PAINT);
	const env = {
		HOME: home,
		USERPROFILE: home,
		PATH: process.env.PATH ?? "",
		TERM: "xterm-256color",
		LC_ALL: "C.UTF-8",
		ATOMIC_CODING_AGENT_DIR: agentDir,
		ATOMIC_SKIP_VERSION_CHECK: "1",
		ATOMIC_TELEMETRY: "0",
		...(options.holdFirstPaint ? { STATUS_PROBE_GATE: gate } : {}),
	};
	const runtime = options.runtime ?? "Bun";
	const preload = options.holdFirstPaint ? [runtime === "Bun" ? "--preload" : "--require", quote(holdFirstPaint)] : [];
	const program =
		options.script !== undefined
			? [quote(bunExecutable()), quote(script)]
			: [
					...(runtime === "Bun"
						? [quote(bunExecutable()), ...preload, quote(cliPath)]
						: ["node", ...preload, quote(builtCliPath)]),
					"--offline --no-mcp",
					...(options.host === "isolated" ? [`--session-dir ${quote(join(root, "sessions"))}`] : []),
					`-e ${quote(extension)}`,
					"--append-system-prompt 'startup status probe'",
				];
	const command = [
		"env -i",
		...Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`),
		...(options.strace ? ["strace -qq -xx -s 1000000 -e trace=write,writev", `-o ${quote(options.strace)}`] : []),
		...program,
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
		`${options.commandLine ? "echo '$ atomic'; " : ""}${options.launcher === undefined ? "" : `printf '%s' ${quote(options.launcher)}; `}${command}; code=$?; echo; echo ${EXIT_MARK}$code`,
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
		waitForPaintHeld: () =>
			waitFor(
				"the interface's first frame to be held",
				STARTUP_TIMEOUT_MS,
				() => (existsSync(join(gate, "painting")) ? true : undefined),
				screen,
			),
		releasePaint: () => writeFileSync(join(gate, "painted"), ""),
		/** Answer the trust question for this session only (its first choice), wait for the prompt and quit. */
		async quit() {
			await waitForScreen("the trust question", STARTUP_TIMEOUT_MS, (pane) => pane.includes(TRUST_QUESTION));
			tmux("send-keys", "-t", "status", "Enter");
			await waitForScreen("the prompt", STARTUP_TIMEOUT_MS, (pane) => !pane.includes(TRUST_QUESTION));
			return this.quitInterface();
		},
		/** Wait for the interface's prompt and quit. */
		async quitInterface() {
			await waitForScreen("the prompt", STARTUP_TIMEOUT_MS, (pane) => pane.includes(INTERFACE_PROMPT));
			tmux("send-keys", "-t", "status", "-l", "/quit");
			// Enter may first only pick the command from the completion list; it is pressed again until atomic exits.
			let pressed = 0;
			return waitFor(
				"atomic to exit",
				STARTUP_TIMEOUT_MS,
				() => {
					const pane = screen();
					if (pane.includes(EXIT_MARK)) return pane;
					if (Date.now() - pressed > 1_000) {
						tmux("send-keys", "-t", "status", "Enter");
						pressed = Date.now();
					}
					return undefined;
				},
				screen,
			);
		},
		stop: () => spawnSync("tmux", ["-S", socket, "kill-server"], { timeout: TMUX_COMMAND_TIMEOUT_MS }),
	};
}

/**
 * The text of each write call the program made to the terminal, from an strace log: the terminal is whatever the
 * status line was written to (a runtime may write to it through a descriptor of its own).
 */
function terminalWrites(straceLog: string): string[] {
	const writes = straceLog.split("\n").flatMap((line) => {
		const call = /^writev?\((\d+),/.exec(line);
		if (!call) return [];
		const bytes = [...line.matchAll(/\\x([0-9a-f]{2})/g)].map((hex) => Number.parseInt(hex[1]!, 16));
		return [{ fd: call[1], data: Buffer.from(bytes).toString("utf8") }];
	});
	const terminal = writes.find((write) => write.data.includes(STATUS_TEXT))?.fd;
	return writes.filter((write) => write.fd === terminal).map((write) => write.data);
}

/** The host's writes to the terminal up to and including the one that switches to the interface's screen. */
function waitForInterface(probe: ReturnType<typeof startProbe>, log: string): Promise<string[]> {
	return waitFor(
		"the interface's first frame",
		STARTUP_TIMEOUT_MS,
		() => {
			const writes = existsSync(log) ? terminalWrites(readFileSync(log, "utf8")) : [];
			const handoff = writes.findIndex((data) => data.includes(ENTER_ALT_SCREEN));
			return handoff === -1 ? undefined : writes.slice(0, handoff + 1);
		},
		probe.screen,
	);
}

/**
 * Replays `writes` on a terminal of the pane's size, one write at a time, as a terminal may show each on its own: from
 * the first that draws the status line, every screen shows the status line, a startup dialog or the interface.
 */
async function expectNeverBlank(writes: readonly string[]): Promise<void> {
	const terminal = new VirtualTerminal(100, 30);
	const first = writes.findIndex((data) => data.includes(STATUS_TEXT));
	expect(first).toBeGreaterThanOrEqual(0);
	for (const [index, data] of writes.entries()) {
		terminal.write(data);
		if (index < first) continue;
		const screen = (await terminal.flushAndGetViewport()).join("\n");
		const shown = [STATUS_TEXT, TRUST_QUESTION, INTERFACE_PROMPT].some((text) => screen.includes(text));
		expect(shown, `after write ${index}, ${JSON.stringify(data.slice(0, 120))}, the screen was:\n${screen}`).toBe(
			true,
		);
	}
}

describe.skipIf(!tmuxAvailable).each(["Bun", "Node"] as const)(
	"the startup status line leaves the rest of the terminal as it was, on %s (#5546)",
	(runtime) => {
		const unavailable = runtime === "Node" && !builtCliAvailable;

		it.skipIf(unavailable).each(["Ctrl+C", "/quit"] as const)(
			"keeps what a launcher printed without ending its row, through %s",
			async (end) => {
				const probe = startProbe({
					host: "isolated",
					runtime,
					launcher: WIDE_TEXT,
					trusted: end === "/quit",
					released: end === "/quit",
				});
				try {
					let waiting: string | undefined;
					let exited: string;
					if (end === "Ctrl+C") {
						await probe.waitForLoading();
						waiting = await probe.waitForScreen("the startup status", STATUS_TIMEOUT_MS, (pane) =>
							pane.includes("Atomic…"),
						);
						probe.tmux("send-keys", "-t", "status", "C-c");
						exited = await probe.waitForScreen("atomic to exit", STARTUP_TIMEOUT_MS, (pane) =>
							pane.includes(EXIT_MARK),
						);
						expect(exited).toContain(`${EXIT_MARK}130`);
					} else {
						exited = await probe.quitInterface();
						expect(exited).toContain(`${EXIT_MARK}0`);
					}
					// Erasing the line took nothing else: the launcher's text is still there, on its row, as without the line.
					expect(rowsOf(exited)).toContain(WIDE_TEXT);
					expect(statusRows(exited)).toEqual([]);
					if (waiting !== undefined) {
						// While it showed, the line was a row of its own, and the launcher's row stayed as it printed it.
						expect(rowsOf(waiting)).toContain(WIDE_TEXT);
						expect(statusRows(waiting)).toEqual([STATUS_TEXT]);
					}
				} finally {
					probe.stop();
				}
			},
			STARTUP_TIMEOUT_MS * 2 + STATUS_TIMEOUT_MS,
		);

		it.skipIf(unavailable)(
			"erases no part of the line when the terminal narrows while the interface's first frame is drawn",
			async () => {
				const probe = startProbe({
					host: "isolated",
					runtime,
					trusted: true,
					released: true,
					commandLine: true,
					holdFirstPaint: true,
				});
				try {
					await probe.waitForPaintHeld();
					expect(statusRows(probe.screen())).toEqual([STATUS_TEXT]);
					// The terminal rewraps the line over several rows while the first frame is being drawn.
					probe.tmux("resize-window", "-t", "status", "-x", "4", "-y", "30");
					await new Promise((resolve) => setTimeout(resolve, 300));
					probe.releasePaint();
					await new Promise((resolve) => setTimeout(resolve, 500));
					probe.tmux("resize-window", "-t", "status", "-x", "100", "-y", "30");
					const exited = await probe.quitInterface();
					expect(exited).toContain(`${EXIT_MARK}0`);
					// The line was not erased after the terminal rewrapped it: whatever is left of it is all of it, in order.
					// tmux does not rewrap the normal screen while the interface's screen is shown, so after widening it may
					// show the line over two rows, as it does any long line there.
					const left = statusRows(exited);
					if (left.length > 0) expect(left.join("")).toBe(STATUS_TEXT);
					expect(rowsOf(exited)).toContain("$ atomic");
				} finally {
					probe.stop();
				}
			},
			STARTUP_TIMEOUT_MS * 2 + STATUS_TIMEOUT_MS,
		);

		it.skipIf(unavailable).each([
			["a row", "ok\\r\\n"],
			// Over the line, had it been drawn.
			["a row after moving the cursor up one", "\\u001b[1Aok\\r\\n"],
		])(
			"draws no line where extensions run in the interactive process, so what their child prints (%s) stays as printed",
			async (_kind, printed) => {
				const probe = startProbe({
					host: "in-process",
					runtime,
					extension: [`spawnSync("printf", ["${printed}"], { stdio: "inherit" });`],
				});
				try {
					await probe.waitForLoading();
					const screen = await probe.waitForScreen("the child's output", STATUS_TIMEOUT_MS, (pane) =>
						pane.includes("ok"),
					);
					expect(rowsOf(screen)).toContain("ok");
					expect(statusRows(screen)).toEqual([]);
					probe.tmux("send-keys", "-t", "status", "C-c");
					const exited = await probe.waitForScreen("atomic to exit", STARTUP_TIMEOUT_MS, (pane) =>
						pane.includes(EXIT_MARK),
					);
					expect(rowsOf(exited)).toContain("ok");
					expect(statusRows(exited)).toEqual([]);
				} finally {
					probe.stop();
				}
			},
			STARTUP_TIMEOUT_MS + STATUS_TIMEOUT_MS * 2,
		);
	},
);

describe.skipIf(!tmuxAvailable)("the startup status line in a real terminal (#5546)", () => {
	it(
		"shows that it is starting while the isolated host waits for the engine's trust question, which replaces it",
		async () => {
			const probe = startProbe({ host: "isolated" });
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
				// Nothing else wrote to the terminal, so the question takes the status line's place.
				expect(asked).not.toContain(STATUS_TEXT);
				const exited = await probe.quit();
				expect(exited).toContain(`${EXIT_MARK}0`);
				expect(statusRows(exited)).toEqual([]);
			} finally {
				probe.stop();
			}
		},
		STARTUP_TIMEOUT_MS * 4 + STATUS_TIMEOUT_MS,
	);

	/** A process that shows the status line, as the isolated host does, then runs `writes` while startup waits. */
	const statusScript = (...writes: string[]) =>
		[
			'import { showStartupStatus, clearStartupStatus } from "$SRC/cli/startup-status.ts";',
			"showStartupStatus();",
			...writes,
			"$HOLD",
			// Startup ends.
			"clearStartupStatus();",
		].join("\n");

	it(
		"keeps console output and the whole status line on rows of their own until startup ends",
		async () => {
			const probe = startProbe({
				host: "isolated",
				script: statusScript(
					`console.log(${JSON.stringify(EXTENSION_OUTPUT)});`,
					`console.log(${JSON.stringify(WIDE_TEXT)});`,
				),
			});
			try {
				await probe.waitForLoading();
				const printed = await probe.waitForScreen("the console output", STATUS_TIMEOUT_MS, (pane) =>
					pane.includes(WIDE_TEXT),
				);
				expect(rowsOf(printed)).toEqual(expect.arrayContaining([EXTENSION_OUTPUT, WIDE_TEXT]));
				expect(statusRows(printed)).toEqual([STATUS_TEXT]);

				probe.release();
				const exited = await probe.waitForScreen("the script to exit", STARTUP_TIMEOUT_MS, (pane) =>
					pane.includes(EXIT_MARK),
				);
				expect(rowsOf(exited)).toEqual(expect.arrayContaining([EXTENSION_OUTPUT, WIDE_TEXT]));
				// Others wrote after the line, so the line stays, whole: removing it could take their output too.
				expect(statusRows(exited)).toEqual([STATUS_TEXT]);
			} finally {
				probe.stop();
			}
		},
		STARTUP_TIMEOUT_MS * 2 + STATUS_TIMEOUT_MS,
	);

	it(
		"keeps output that has not ended its row when a console call prints nothing",
		async () => {
			const probe = startProbe({
				host: "isolated",
				script: statusScript(
					`process.stdout.write(${JSON.stringify(WIDE_TEXT)});`,
					"console.assert(true);",
					'process.stdout.write(" suffix\\n");',
				),
			});
			try {
				await probe.waitForLoading();
				const printed = await probe.waitForScreen("the extension's output", STATUS_TIMEOUT_MS, (pane) =>
					pane.includes("suffix"),
				);
				expect(rowsOf(printed)).toContain(`${WIDE_TEXT} suffix`);
				expect(statusRows(printed)).toEqual([STATUS_TEXT]);
			} finally {
				probe.stop();
			}
		},
		STARTUP_TIMEOUT_MS + STATUS_TIMEOUT_MS * 2,
	);

	it.each([
		["cursor-hiding bytes", 'process.stdout.write(Buffer.from("\\x1b[?25l"));', undefined],
		[
			"a line followed by a color reset",
			`process.stdout.write("\\x1b[33m" + ${JSON.stringify(WIDE_TEXT)} + "\\n\\x1b[0m");`,
			WIDE_TEXT,
		],
	])(
		"still shows that it is starting after %s are written",
		async (_kind, write, output) => {
			const probe = startProbe({ host: "isolated", script: statusScript(write) });
			try {
				await probe.waitForLoading();
				// Long enough for the write to reach the terminal; the status line must be there for as long as startup waits.
				await new Promise((resolve) => setTimeout(resolve, 500));
				const waiting = await probe.waitForScreen("the startup status", STATUS_TIMEOUT_MS, (pane) =>
					pane.includes(STATUS_TEXT),
				);
				expect(statusRows(waiting)).toEqual([STATUS_TEXT]);
				if (output !== undefined) expect(rowsOf(waiting)).toContain(output);
			} finally {
				probe.stop();
			}
		},
		STARTUP_TIMEOUT_MS + STATUS_TIMEOUT_MS * 2,
	);

	it(
		"keeps what a package command printed without ending its row",
		async () => {
			const probe = startProbe({
				host: "in-process",
				script: [
					'import { showStartupStatus, clearStartupStatus } from "$SRC/cli/startup-status.ts";',
					'import { runCommand } from "$SRC/core/package-manager-command.ts";',
					"showStartupStatus();",
					`await runCommand("sh", ["-c", ${JSON.stringify(`printf '${WIDE_TEXT}'`)}]);`,
					"$HOLD",
					// Startup ends.
					"clearStartupStatus();",
				].join("\n"),
			});
			try {
				await probe.waitForLoading();
				const printed = await probe.waitForScreen("the command's output", STATUS_TIMEOUT_MS, (pane) =>
					pane.includes(WIDE_TEXT),
				);
				// The command exited and startup still runs: its output stays as it printed it.
				await new Promise((resolve) => setTimeout(resolve, 300));
				expect(rowsOf(probe.screen())).toContain(WIDE_TEXT);
				expect(statusRows(printed)).toEqual([STATUS_TEXT]);

				probe.release();
				const exited = await probe.waitForScreen("the script to exit", STARTUP_TIMEOUT_MS, (pane) =>
					pane.includes(EXIT_MARK),
				);
				expect(rowsOf(exited)).toContain(WIDE_TEXT);
				expect(statusRows(exited)).toEqual([STATUS_TEXT]);
			} finally {
				probe.stop();
			}
		},
		STARTUP_TIMEOUT_MS * 2 + STATUS_TIMEOUT_MS,
	);

	it(
		"leaves no piece of the status line behind when the terminal narrows, startup is cancelled and it widens again",
		async () => {
			const probe = startProbe({ host: "isolated", commandLine: true });
			try {
				await probe.waitForLoading();
				await probe.waitForScreen("the startup status", STATUS_TIMEOUT_MS, (pane) => pane.includes(STATUS_TEXT));

				// Much narrower than the line: the terminal rewraps it over several rows and moves some into its history.
				probe.tmux("resize-window", "-t", "status", "-x", "4", "-y", "30");
				await new Promise((resolve) => setTimeout(resolve, 300));
				probe.tmux("send-keys", "-t", "status", "C-c");
				await probe.waitForScreen("atomic to exit", STARTUP_TIMEOUT_MS, (pane) => pane.includes(EXIT_MARK));
				probe.tmux("resize-window", "-t", "status", "-x", "100", "-y", "30");
				const exited = await probe.waitForScreen("the wide terminal", STATUS_TIMEOUT_MS, (pane) =>
					rowsOf(pane).some((row) => row.startsWith(EXIT_MARK)),
				);
				expect(exited).toContain(`${EXIT_MARK}130`);
				// The whole line may stay where the terminal moved it; a piece of it never does.
				expect(statusRows(exited).every((row) => row === STATUS_TEXT)).toBe(true);
				expect(rowsOf(exited)).toContain("$ atomic");
			} finally {
				probe.stop();
			}
		},
		STARTUP_TIMEOUT_MS * 2 + STATUS_TIMEOUT_MS * 2,
	);

	it.skipIf(!straceAvailable)(
		"replaces the status line with the interface's first frame in one write, so the screen is never blank",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "atomic-startup-writes-"));
			tempDirs.push(root);
			const log = join(root, "writes.log");
			const probe = startProbe({ host: "isolated", trusted: true, released: true, strace: log });
			try {
				const writes = await waitForInterface(probe, log);
				const handoff = writes.findIndex((data) => data.includes(ENTER_ALT_SCREEN));
				const frame = writes[handoff]!;
				// The write that switches to the interface's screen also erases the line, and draws the interface.
				expect(frame.slice(0, frame.indexOf(ENTER_ALT_SCREEN))).toContain("\x1b[2K");
				await expectNeverBlank(writes);
			} finally {
				probe.stop();
			}
		},
		STARTUP_TIMEOUT_MS + STATUS_TIMEOUT_MS,
	);

	it.skipIf(!straceAvailable)(
		"replaces the status line with the trust question, and the question with it, so the screen is never blank",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "atomic-startup-writes-"));
			tempDirs.push(root);
			const log = join(root, "writes.log");
			const probe = startProbe({ host: "isolated", released: true, strace: log });
			try {
				await probe.waitForScreen("the trust question", STARTUP_TIMEOUT_MS, (pane) =>
					pane.includes(TRUST_QUESTION),
				);
				probe.tmux("send-keys", "-t", "status", "Enter");
				await expectNeverBlank(await waitForInterface(probe, log));
			} finally {
				probe.stop();
			}
		},
		STARTUP_TIMEOUT_MS * 2 + STATUS_TIMEOUT_MS,
	);
});
