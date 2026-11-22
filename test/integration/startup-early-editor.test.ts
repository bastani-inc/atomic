import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import xterm from "@xterm/headless";
import { afterEach, describe, test } from "vitest";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { prepareAgentDir, prepareInstalledPackage } from "../helpers/event-loop-guard-fixture.js";
import { type PtyExit, type PtyProgram, startPtyProgram } from "../helpers/pty-program.js";
import { recordProcess, signalRecordedProcess } from "../helpers/recorded-process.js";
import { makeTempDirectory, moduleDir, sleep } from "../helpers/runtime.js";

const PACKAGE = join(moduleDir(import.meta.url), "../../packages/coding-agent");
const CLI_TIMEOUT_MS = 90_000;
/** The session's own interface names the model, in its footer from its first frame; the early editor does not. */
const SESSION_HEADER = "guard-model";
/** Between the two parts of a paste: long enough for the session to become ready meanwhile on a fast machine. */
const SPLIT_PASTE_GAP_MS = 1_000;
/** Longer than the terminal waits before it reads a lone Esc as one locally (10 ms), shorter than Atomic's load. */
const KEYS_APART_MS = 60;
/** Longer than the terminal waits before it reads a lone Esc as one (10 ms locally, 100 ms over SSH). */
const LONE_ESCAPE_GAP_MS = 300;
/** Long enough for several of a 50 ms check's turns. */
const WRITER_CHECK_WAIT_MS = 500;
/**
 * How long a test that must act while the early editor shows holds back the session's main module, which the CLI
 * imports once the early editor shows: far longer than the test takes to see the prompt and type, on a loaded machine.
 */
const SESSION_HELD_BACK_MS = 5_000;
/** A real CLI child plus its startup under a loaded machine: structural, not a slow test. */
const REAL_CLI_TEST_TIMEOUT_MS = 3 * CLI_TIMEOUT_MS;

const programs: PtyProgram[] = [];
const roots: string[] = [];
afterEach(async () => {
	for (const program of programs.splice(0)) program.kill();
	for (const root of roots.splice(0)) await removeTempRootReleasingBroker(root);
});

function startCli(
	args: readonly string[],
	env: Record<string, string> = {},
	prepare?: (agentDir: string) => void,
): PtyProgram {
	const root = makeTempDirectory("atomic-early-editor-");
	roots.push(root);
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	const installed = join(root, "package");
	mkdirSync(project, { recursive: true });
	prepareAgentDir(agentDir, "http://127.0.0.1:9");
	prepareInstalledPackage(PACKAGE, installed);
	prepare?.(agentDir);
	const program = startPtyProgram({
		executable: process.execPath,
		args: [join(PACKAGE, "dist/cli.js"), "--offline", ...args],
		cwd: project,
		env: {
			...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
			HOME: root,
			USERPROFILE: root,
			ATOMIC_CODING_AGENT_DIR: agentDir,
			ATOMIC_PACKAGE_DIR: installed,
			ATOMIC_SKIP_VERSION_CHECK: "1",
			ATOMIC_TELEMETRY: "0",
			TERM: "xterm-256color",
			// A user's terminal, also on a CI runner: in CI the session draws on the main screen, with no early editor.
			CI: "0",
			...env,
		},
		timeoutMs: CLI_TIMEOUT_MS,
		cols: 100,
		rows: 30,
	});
	programs.push(program);
	return program;
}

const BEGIN_SYNC = "\x1b[?2026h";
const END_SYNC = "\x1b[?2026l";

/**
 * Every screen a terminal could have shown for `output`: the screen before each synchronized update begins (what the
 * writes outside one left) and after each one ends.
 */
async function screensOf(output: string, cols: number, rows: number): Promise<string[]> {
	const replay = new xterm.Terminal({ cols, rows, allowProposedApi: true });
	const write = (data: string) => new Promise<void>((resolve) => replay.write(data, resolve));
	const viewport = () => {
		const buffer = replay.buffer.active;
		const lines: string[] = [];
		for (let row = 0; row < replay.rows; row++)
			lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
		return lines.join("\n");
	};
	const screens: string[] = [];
	for (const piece of output.split(/(?=\x1b\[\?2026h)|(?<=\x1b\[\?2026l)/)) {
		if (piece.startsWith(BEGIN_SYNC)) screens.push(viewport());
		await write(piece);
		if (piece.endsWith(END_SYNC)) screens.push(viewport());
	}
	screens.push(viewport());
	return screens;
}

/**
 * The lines of the normal screen, scrollback included, once `output` has been replayed, with trailing blanks dropped:
 * what the user sees above their shell's next prompt.
 */
async function normalScreenLines(output: string, cols: number, rows: number): Promise<string[]> {
	const replay = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
	await new Promise<void>((resolve) => replay.write(output, resolve));
	const buffer = replay.buffer.normal;
	const lines: string[] = [];
	for (let row = 0; row < buffer.length; row++)
		lines.push(buffer.getLine(row)?.translateToString(true).trimEnd() ?? "");
	return lines.filter((line) => line !== "");
}

/** The prompt line of the screen, from the prompt marker on. */
function promptLine(screen: string): string | undefined {
	return screen
		.split("\n")
		.find((line) => line.trimStart().startsWith("❯"))
		?.trim();
}

for (const [host, trust] of [
	["isolated engine", "--approve"],
	["in-process", "--no-approve"],
] as const) {
	describe(`the early editor, ${host} host`, () => {
		test(
			"shows the prompt before the session is ready, and the session keeps what was typed there",
			async () => {
				const program = startCli([trust]);
				await program.waitForScreen((screen) => screen.includes("❯"), CLI_TIMEOUT_MS, "the prompt");
				assert.equal(program.screen().includes(SESSION_HEADER), false, "the prompt came before the session");
				program.write("early words");
				await program.waitForScreen(
					(screen) => promptLine(screen) === "❯ early words",
					CLI_TIMEOUT_MS,
					"the typed text",
				);
				await program.waitForScreen((screen) => screen.includes(SESSION_HEADER), CLI_TIMEOUT_MS, "the session");
				assert.equal(promptLine(program.screen()), "❯ early words", "the session kept the prompt");
				program.write(" and later");
				await program.waitForScreen(
					(screen) => promptLine(screen) === "❯ early words and later",
					CLI_TIMEOUT_MS,
					"an edit after the session took over",
				);
			},
			REAL_CLI_TEST_TIMEOUT_MS,
		);

		// The frames are read from the program's own synchronized updates. On Windows the pseudo console redraws the
		// screen in its own output instead of passing those updates through, so there is nothing to read them from.
		test.skipIf(process.platform === "win32")(
			"the session takes over the screen without clearing the prompt in any frame",
			async () => {
				const program = startCli([trust]);
				await program.waitForScreen((screen) => screen.includes("❯"), CLI_TIMEOUT_MS, "the prompt");
				program.write("kept on screen");
				await program.waitForScreen(
					(screen) => promptLine(screen) === "❯ kept on screen",
					CLI_TIMEOUT_MS,
					"the typed text",
				);
				await program.waitForScreen((screen) => screen.includes(SESSION_HEADER), CLI_TIMEOUT_MS, "the session");
				const screens = await screensOf(program.output(), 100, 30);
				const typed = screens.findIndex((screen) => promptLine(screen)?.startsWith("❯ kept") === true);
				const bound = screens.findIndex((screen) => screen.includes(SESSION_HEADER));
				assert.ok(
					typed !== -1 && bound > typed,
					`the typing showed before the session's first frame (${typed}, ${bound})`,
				);
				// From the first typed key on, every frame shows the prompt with what was typed so far: never a cleared
				// screen, never a shorter prompt.
				let shown = "";
				for (const [index, screen] of screens.slice(typed).entries()) {
					const line = promptLine(screen) ?? "";
					assert.ok(line.startsWith("❯ kept") && line.length >= shown.length, `frame ${typed + index}: ${line}`);
					shown = line;
				}
				assert.equal(promptLine(screens[bound] ?? ""), promptLine(screens.at(-1) ?? ""));
			},
			REAL_CLI_TEST_TIMEOUT_MS,
		);

		test(
			"keys after one that waits for the session keep their order, and a paste stays a paste",
			async () => {
				const program = startCli([trust]);
				await program.waitForScreen((screen) => screen.includes("❯"), CLI_TIMEOUT_MS, "the prompt");
				// Left on a prompt with text moves the cursor, here and in the session. Esc means more than an edit, so it
				// and every key after it wait for the session.
				program.write("ab\x1b[Dc\x1b[200~ pasted \x1b[201~");
				await program.waitForScreen(
					(screen) => promptLine(screen) === "❯ ac pasted b",
					CLI_TIMEOUT_MS,
					"the edits",
				);
				program.write("\x1b");
				// Apart, so the terminal reads a lone Esc rather than the start of a sequence.
				await sleep(LONE_ESCAPE_GAP_MS);
				program.write("\x1b[Dd");
				await program.waitForScreen((screen) => screen.includes(SESSION_HEADER), CLI_TIMEOUT_MS, "the session");
				// The cursor sat after the paste, before "b": Left moves it before the paste's last space.
				await program.waitForScreen(
					(screen) => promptLine(screen) === "❯ ac pastedd b",
					CLI_TIMEOUT_MS,
					"the held keys applied in order",
				);
			},
			REAL_CLI_TEST_TIMEOUT_MS,
		);

		test(
			"a paste still arriving when the session is ready arrives whole, with no terminal answer inside it",
			async () => {
				const program = startCli([trust]);
				await program.waitForScreen((screen) => screen.includes("❯"), CLI_TIMEOUT_MS, "the prompt");
				program.write("A\x1b[200~界");
				// A terminal sends a paste at once; this one arrives in two parts, the second a little later.
				await sleep(SPLIT_PASTE_GAP_MS);
				program.write("👩‍💻\x1b[201~!");
				await program.waitForScreen((screen) => screen.includes(SESSION_HEADER), CLI_TIMEOUT_MS, "the session");
				// Windows' pseudo console draws the joined emoji wider than one character pair, which can push the
				// prompt's border onto its line: only blanks and border may follow the text.
				await program.waitForScreen(
					(screen) => /^❯ A界👩‍💻![\s─]*$/u.test(promptLine(screen) ?? ""),
					CLI_TIMEOUT_MS,
					"the whole paste",
				);
			},
			REAL_CLI_TEST_TIMEOUT_MS,
		);

		test(
			"runs a command entered before the session is ready once the session is, exactly once",
			async () => {
				const program = startCli([trust]);
				await program.waitForScreen((screen) => screen.includes("❯"), CLI_TIMEOUT_MS, "the prompt");
				program.write("/quit\r");
				const exit = (await program.exited) as PtyExit;
				assert.equal(exit.timedOut, false);
				assert.equal(exit.exitCode, 0);
				assert.equal(program.screen().includes("Unknown command"), false);
			},
			REAL_CLI_TEST_TIMEOUT_MS,
		);

		test(
			"a sequence no key means anything to does not hold the keys after it until the session",
			async () => {
				const program = startCli([trust]);
				await program.waitForScreen((screen) => screen.includes("❯"), CLI_TIMEOUT_MS, "the prompt");
				// What some terminals send as a program starts (here a function key's encoding no key of Atomic's has).
				program.write("\x1b[[C");
				program.write("abc");
				await program.waitForScreen(
					(screen) => promptLine(screen) === "❯ abc" && !screen.includes(SESSION_HEADER),
					CLI_TIMEOUT_MS,
					"the typing in the early editor",
				);
			},
			REAL_CLI_TEST_TIMEOUT_MS,
		);

		test(
			"Esc typed apart from the next key stays Esc while Atomic loads, not that key with Alt",
			async () => {
				const program = startCli([trust]);
				await program.waitForScreen((screen) => screen.includes("❯"), CLI_TIMEOUT_MS, "the prompt");
				// While Atomic loads its modules it reads keys late: an Esc and the key typed after it arrive together.
				program.write("/qu\x1b");
				await sleep(KEYS_APART_MS);
				program.write("it\r");
				const exit = (await program.exited) as PtyExit;
				assert.equal(exit.timedOut, false);
				assert.equal(exit.exitCode, 0);
			},
			REAL_CLI_TEST_TIMEOUT_MS,
		);

		test(
			"a command typed with Enter before Atomic has even set up the terminal runs once the session is ready",
			async () => {
				const program = startCli([trust]);
				// Before the terminal is in raw mode, its line discipline turns Enter into a line feed.
				program.write("/quit\r");
				const exit = (await program.exited) as PtyExit;
				assert.equal(exit.timedOut, false);
				assert.equal(exit.exitCode, 0);
			},
			REAL_CLI_TEST_TIMEOUT_MS,
		);

		test(
			"Ctrl+C twice on the empty prompt exits, as in the session",
			async () => {
				const program = startCli([trust]);
				await program.waitForScreen((screen) => screen.includes("❯"), CLI_TIMEOUT_MS, "the prompt");
				program.write("\x03");
				program.write("\x03");
				const exit = (await program.exited) as PtyExit;
				assert.equal(exit.timedOut, false);
				assert.equal(exit.exitCode, 0);
			},
			REAL_CLI_TEST_TIMEOUT_MS,
		);

		test(
			"one Ctrl+C that waited for the session is one press there, and Atomic keeps running",
			async () => {
				const program = startCli([trust]);
				await program.waitForScreen((screen) => screen.includes("❯"), CLI_TIMEOUT_MS, "the prompt");
				// Up can mean more than an edit, so it and the Ctrl+C after it wait for the session.
				program.write("\x1b[A");
				program.write("\x03");
				await program.waitForScreen((screen) => screen.includes(SESSION_HEADER), CLI_TIMEOUT_MS, "the session");
				// The session takes the waiting keys before this one.
				program.write("x");
				await program.waitForScreen(
					(screen) => promptLine(screen) === "❯ x",
					CLI_TIMEOUT_MS,
					"a key after the Ctrl+C",
				);
			},
			REAL_CLI_TEST_TIMEOUT_MS,
		);
	});
}

test(
	"a startup error after the prompt showed is printed where the user sees it, and nothing of the prompt stays",
	async () => {
		const program = startCli(["--approve"], { ATOMIC_STORAGE: "{not json" });
		const exit = (await program.exited) as PtyExit;
		assert.equal(exit.exitCode, 1);
		const output = program.output();
		// Its prompt marker, in the program's own output or in what Windows' pseudo console redrew from it.
		assert.ok(output.includes("❯"), "the early editor showed before the error");
		// As without the early editor: the screen shows the error, once, after everything else, and no line of the prompt.
		const lines = ((await screensOf(output, 100, 30)).at(-1) ?? "")
			.split("\n")
			.map((line) => line.trimEnd())
			.filter((line) => line !== "");
		assert.deepEqual(
			lines.filter((line) => /[❯─]/u.test(line)),
			[],
			`the prompt's lines are gone:\n${lines.join("\n")}`,
		);
		const errors = lines.flatMap((line, index) => (/Error: .*ATOMIC_STORAGE/.test(line) ? [index] : []));
		assert.equal(errors.length, 1, `the error is shown once:\n${lines.join("\n")}`);
		assert.equal(lines.at(-1), lines[errors[0]!], `the error is the last thing on the screen:\n${lines.join("\n")}`);
	},
	REAL_CLI_TEST_TIMEOUT_MS,
);

test(
	"a startup warning that waits for a key after the prompt showed is shown alone, and nothing of the prompt stays",
	async () => {
		// A hooks/ directory in the agent directory makes startup print a warning and wait for a key before the session.
		const program = startCli(["--approve"], {}, (agentDir) => mkdirSync(join(agentDir, "hooks")));
		await program.waitForScreen(
			(screen) => screen.includes("Press any key to continue"),
			CLI_TIMEOUT_MS,
			"the warning",
		);
		assert.ok(program.output().includes("❯"), "the early editor showed before the warning");
		// As without the early editor: the screen shows the warning and no line of the prompt.
		const lines = program
			.screen()
			.split("\n")
			.map((line) => line.trimEnd())
			.filter((line) => line !== "");
		assert.deepEqual(
			lines.filter((line) => /[❯─]/u.test(line)),
			[],
			`the prompt's lines are gone:\n${lines.join("\n")}`,
		);
		assert.ok(
			lines.some((line) => line.includes("hooks/ directory found")),
			`the warning is shown:\n${lines.join("\n")}`,
		);
		program.write("x");
		await program.waitForScreen((screen) => screen.includes(SESSION_HEADER), CLI_TIMEOUT_MS, "the session");
	},
	REAL_CLI_TEST_TIMEOUT_MS,
);

// While the session's screen is up, Windows' pseudo console redraws it in its own output instead of passing the
// switch to it through, so the screen under it cannot be read there; the line is read there once Atomic exits.
for (const after of ["Atomic exits", "the session starts"] as const)
	test.skipIf(process.platform === "win32" && after === "the session starts")(
		`a line written to standard output while the prompt shows is printed where the user sees it, once, when ${after}`,
		async () => {
			const dir = makeTempDirectory("atomic-early-editor-stdout-");
			roots.push(dir);
			const preload = join(dir, "stdout-line.cjs");
			// Once the prompt is on the screen, another module writes a line to standard output itself, not through the
			// console. Only in the process that shows the early editor: an engine child writes nothing.
			writeFileSync(
				preload,
				`if (!process.argv.some((arg) => arg.startsWith("--internal-engine"))) {
	const write = process.stdout.write;
	let written = false;
	process.stdout.write = function (chunk, ...rest) {
		const result = write.call(this, chunk, ...rest);
		if (!written && String(chunk).includes("❯")) {
			written = true;
			setImmediate(() =>
				process.stdout.write("A LINE ON STANDARD OUTPUT\\n", () => {
					if (${JSON.stringify(after === "Atomic exits")}) process.exit(1);
				}),
			);
		}
		return result;
	};
}
`,
			);
			const program = startCli(["--approve"], { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` });
			if (after === "Atomic exits") {
				const exit = (await program.exited) as PtyExit;
				assert.equal(exit.timedOut, false);
				assert.equal(exit.exitCode, 1);
			} else {
				await program.waitForScreen((screen) => screen.includes(SESSION_HEADER), CLI_TIMEOUT_MS, "the session");
			}
			const output = program.output();
			assert.ok(output.includes("❯"), "the early editor showed");
			// As without the early editor: the screen the user returns to (under the session's own screen while it runs)
			// shows the line, once, and no line of the prompt.
			const lines = await normalScreenLines(output, 100, 30);
			assert.deepEqual(lines, ["A LINE ON STANDARD OUTPUT"], `only the line is on the screen:\n${lines.join("\n")}`);
		},
		REAL_CLI_TEST_TIMEOUT_MS,
	);

for (const [quit, keys] of [
	["Ctrl+C twice", "\x03\x03"],
	["Ctrl+D", "\x04"],
] as const)
	test(
		`${quit} on the early editor's empty prompt exits and leaves its last frame on the screen, as the session does`,
		async () => {
			const dir = makeTempDirectory("atomic-early-editor-quit-");
			roots.push(dir);
			// The session's main module loads only after a wait, so the session cannot be ready before the keys typed
			// meanwhile reach the early editor. Where Node holds input until that module has loaded, the keys still
			// reach the early editor first, as soon as it has, long before the session it starts is ready.
			// Only in the process that shows the early editor: an engine child (`--internal-engine-…`) loads as usual.
			const hooks = join(dir, "hold-main.mjs");
			writeFileSync(
				hooks,
				`export async function load(url, context, nextLoad) {
	if (/[\\\\/]dist[\\\\/]main\\.js$/.test(url)) await new Promise((resolve) => setTimeout(resolve, ${SESSION_HELD_BACK_MS}));
	return nextLoad(url, context);
}
`,
			);
			const preload = join(dir, "register-hold-main.mjs");
			writeFileSync(
				preload,
				`import { register } from "node:module";\nif (!process.argv.some((arg) => arg.startsWith("--internal-engine"))) register(${JSON.stringify(pathToFileURL(hooks).href)});\n`,
			);
			const program = startCli(["--approve"], {
				NODE_OPTIONS: `--import ${JSON.stringify(pathToFileURL(preload).href)}`,
			});
			await program.waitForScreen((screen) => screen.includes("❯"), CLI_TIMEOUT_MS, "the prompt");
			program.write(keys);
			const exit = (await program.exited) as PtyExit;
			assert.equal(exit.timedOut, false);
			assert.equal(exit.exitCode, 0);
			const screen = (await screensOf(program.output(), 100, 30)).at(-1) ?? "";
			assert.equal(screen.includes(SESSION_HEADER), false, `the early editor quit, not the session:\n${screen}`);
			// What the session leaves when it exits: its last frame, here the prompt between its borders.
			assert.equal(promptLine(screen), "❯", `the prompt stays on the screen:\n${screen}`);
			assert.ok(
				screen.split("\n").filter((line) => /^─{10,}/u.test(line.trim())).length >= 2,
				`both borders stay on the screen:\n${screen}`,
			);
		},
		REAL_CLI_TEST_TIMEOUT_MS,
	);

test(
	"console, stderr and stdout writers installed while the early editor shows are still in place once the session has taken over",
	async () => {
		const dir = makeTempDirectory("atomic-early-editor-writers-");
		roots.push(dir);
		const preload = join(dir, "late-writer.cjs");
		const report = join(dir, "report.txt");
		// Once the early editor has started drawing, wrap console.warn, stderr and stdout as a diagnostics tool would,
		// and record whether the wrappers are still the ones in place.
		writeFileSync(
			preload,
			`const fs = require("node:fs");
const report = ${JSON.stringify(report)};
const write = process.stdout.write;
let mine;
process.stdout.write = function (chunk, ...rest) {
	if (mine === undefined && String(chunk).includes("\\x1b[?1049h")) {
		const warn = console.warn;
		const stderrWrite = process.stderr.write;
		const stdoutWrite = process.stdout.write;
		mine = {
			warn: (...args) => warn.apply(console, args),
			stderrWrite: (...args) => stderrWrite.apply(process.stderr, args),
			stdoutWrite: (...args) => stdoutWrite.apply(process.stdout, args),
		};
		console.warn = mine.warn;
		process.stderr.write = mine.stderrWrite;
		process.stdout.write = mine.stdoutWrite;
		setInterval(() => {
			const kept =
				console.warn === mine.warn && process.stderr.write === mine.stderrWrite && process.stdout.write === mine.stdoutWrite;
			if (!kept || !fs.existsSync(report)) fs.writeFileSync(report, kept ? "kept" : "replaced");
		}, 50).unref();
	}
	return write.call(this, chunk, ...rest);
};
`,
		);
		const program = startCli(["--approve"], { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` });
		await program.waitForScreen((screen) => screen.includes("❯"), CLI_TIMEOUT_MS, "the prompt");
		await program.waitForScreen((screen) => screen.includes(SESSION_HEADER), CLI_TIMEOUT_MS, "the session");
		// A few of the check's turns after the session took over.
		await sleep(WRITER_CHECK_WAIT_MS);
		assert.equal(readFileSync(report, "utf8"), "kept");
	},
	REAL_CLI_TEST_TIMEOUT_MS,
);

for (const signal of ["SIGTERM", "SIGINT"] as const)
	test.skipIf(process.platform === "win32")(
		`${signal} from outside while the early editor shows ends Atomic with the terminal given back`,
		async () => {
			const dir = makeTempDirectory("atomic-early-editor-signal-");
			roots.push(dir);
			const trace = join(dir, "trace.jsonl");
			const program = startCli(["--approve"], { ATOMIC_STARTUP_TRACE: trace });
			await program.waitForScreen((screen) => screen.includes("❯"), CLI_TIMEOUT_MS, "the prompt");
			assert.equal(program.screen().includes(SESSION_HEADER), false, "the early editor shows");
			// The trace names the process that drew it.
			const pid = (JSON.parse(readFileSync(trace, "utf8").split("\n")[0]!) as { pid: number }).pid;
			await signalRecordedProcess(await recordProcess(pid), signal);
			const exit = (await program.exited) as PtyExit;
			assert.equal(exit.timedOut, false);
			const output = program.output();
			assert.ok(
				output.lastIndexOf("\x1b[?1049l") > output.lastIndexOf("\x1b[?1049h"),
				"the alternate screen was left",
			);
		},
		REAL_CLI_TEST_TIMEOUT_MS,
	);

test(
	"an argument the early editor does not know keeps today's startup: the prompt comes with the session",
	async () => {
		const program = startCli(["--approve", "--name", "early-editor-test"]);
		await program.waitForScreen((screen) => screen.includes("❯"), CLI_TIMEOUT_MS, "the prompt");
		assert.ok(program.screen().includes(SESSION_HEADER), "no prompt before the session");
	},
	REAL_CLI_TEST_TIMEOUT_MS,
);
