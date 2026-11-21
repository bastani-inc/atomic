import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import xterm from "@xterm/headless";
import { afterEach, describe, test } from "vitest";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { prepareAgentDir, prepareInstalledPackage } from "../helpers/event-loop-guard-fixture.js";
import { type PtyExit, type PtyProgram, startPtyProgram } from "../helpers/pty-program.js";
import { makeTempDirectory, moduleDir } from "../helpers/runtime.js";

const PACKAGE = join(moduleDir(import.meta.url), "../../packages/coding-agent");
const CLI_TIMEOUT_MS = 90_000;
/** The session's own interface names the model, in its footer from its first frame; the early editor does not. */
const SESSION_HEADER = "guard-model";
/** A real CLI child plus its startup under a loaded machine: structural, not a slow test. */
const REAL_CLI_TEST_TIMEOUT_MS = 3 * CLI_TIMEOUT_MS;

const programs: PtyProgram[] = [];
const roots: string[] = [];
afterEach(async () => {
	for (const program of programs.splice(0)) program.kill();
	for (const root of roots.splice(0)) await removeTempRootReleasingBroker(root);
});

function startCli(args: readonly string[], env: Record<string, string> = {}): PtyProgram {
	const root = makeTempDirectory("atomic-early-editor-");
	roots.push(root);
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	const installed = join(root, "package");
	mkdirSync(project, { recursive: true });
	prepareAgentDir(agentDir, "http://127.0.0.1:9");
	prepareInstalledPackage(PACKAGE, installed);
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

		test(
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
				// Left can also move between views in the session, so it and every key after it wait for it.
				program.write("ab\x1b[Dc\x1b[200~ pasted \x1b[201~");
				await program.waitForScreen((screen) => screen.includes(SESSION_HEADER), CLI_TIMEOUT_MS, "the session");
				await program.waitForScreen(
					(screen) => promptLine(screen) === "❯ ac pasted b",
					CLI_TIMEOUT_MS,
					"the keys applied in order",
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
	});
}

test(
	"a startup error after the prompt showed is printed where the user sees it",
	async () => {
		const program = startCli(["--approve"], { ATOMIC_STORAGE: "{not json" });
		const exit = (await program.exited) as PtyExit;
		assert.equal(exit.exitCode, 1);
		assert.match(program.screen(), /Error: .*ATOMIC_STORAGE/);
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
