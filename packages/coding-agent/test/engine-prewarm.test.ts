import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import {
	adoptPrewarmedEngine,
	discardPrewarmedEngine,
	type EngineLaunch,
	engineLaunch,
	INTERACTIVE_ENGINE_PREWARM_WRITE_CACHE_FLAG,
	type PrewarmLaunchBasis,
	prewarmInteractiveEngine,
	sameEngineLaunch,
	shouldPrewarmInteractiveEngine,
} from "../src/modes/interactive-engine/engine-prewarm.ts";
import { INTERACTIVE_ENGINE_PREWARM_FLAG } from "../src/utils/interactive-engine-bootstrap.ts";

/** How long a stand-in engine may take to start, or to be gone once stopped, on a loaded runner. */
const ENGINE_START_OR_EXIT_WAIT_MS = 30_000;

const tempDirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
	discardPrewarmedEngine();
	for (const child of children.splice(0)) child.kill();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in engine child: it writes its pid to `pid` beside it, reads its arguments as a prewarmed engine does, then
 * reads stdin with the RPC reader, as the engine does, and reports both on stdout.
 */
function writeEngineScript(): string {
	const dir = mkdtempSync(join(tmpdir(), "atomic-prewarm-"));
	tempDirs.push(dir);
	const path = join(dir, "engine.mjs");
	const prewarm = new URL("../src/modes/interactive-engine/engine-prewarm.ts", import.meta.url).href;
	const jsonl = new URL("../src/modes/rpc/jsonl.ts", import.meta.url).href;
	writeFileSync(
		path,
		`import { writeFileSync } from "node:fs";\n` +
			`writeFileSync(${JSON.stringify(join(dir, "pid"))}, String(process.pid));\n` +
			`writeFileSync(${JSON.stringify(join(dir, "prewarm-argv"))}, JSON.stringify(process.argv.slice(2)));\n` +
			`import { readPrewarmedEngineArgs } from ${JSON.stringify(prewarm)};\n` +
			`import { attachJsonlLineReader } from ${JSON.stringify(jsonl)};\n` +
			"const args = await readPrewarmedEngineArgs();\n" +
			'process.stdout.write(JSON.stringify({ args, argv: process.argv.slice(2) }) + "\\n");\n' +
			'attachJsonlLineReader(process.stdin, (line) => process.stdout.write(JSON.stringify({ line }) + "\\n"));\n',
	);
	return path;
}

function startEngine(script: string): ChildProcess {
	const child = spawn("bun", [script], { stdio: ["pipe", "pipe", "inherit"] });
	children.push(child);
	return child;
}

async function readLines(child: ChildProcess, count: number): Promise<Record<string, unknown>[]> {
	const lines: Record<string, unknown>[] = [];
	let buffered = "";
	return new Promise((resolve, reject) => {
		child.once("exit", (code) => reject(new Error(`engine exited ${code} after ${JSON.stringify(lines)}`)));
		child.stdout!.setEncoding("utf8").on("data", (data: string) => {
			buffered += data;
			for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
				lines.push(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
				buffered = buffered.slice(newline + 1);
				if (lines.length === count) resolve(lines);
			}
		});
	});
}

// The prewarmed child once left stdin paused after reading its handshake, so the engine never read the host's
// requests and the host's first get_state timed out.
describe("a prewarmed engine child", () => {
	test("runs with the arguments of its handshake and then reads every frame the host sends after it", async () => {
		const child = startEngine(writeEngineScript());
		const output = readLines(child, 3);
		// The handshake and the first frames in one write, the rest later: the engine must see every frame.
		child.stdin!.write(`${JSON.stringify({ args: ["--mode", "rpc", "--session", "é"] })}\n{"id":"1"}\n{"id`);
		await new Promise((resolve) => setTimeout(resolve, 50));
		child.stdin!.write('":"2"}\n');
		assert.deepEqual(await output, [
			{ args: ["--mode", "rpc", "--session", "é"], argv: ["--mode", "rpc", "--session", "é"] },
			{ line: '{"id":"1"}' },
			{ line: '{"id":"2"}' },
		]);
	});

	test("reads a handshake split anywhere, even inside a character", async () => {
		const child = startEngine(writeEngineScript());
		const output = readLines(child, 2);
		const bytes = Buffer.from(`${JSON.stringify({ args: ["--session", "日本"] })}\n{"id":"3"}\n`, "utf8");
		const cut = bytes.indexOf(Buffer.from("本", "utf8")) + 1;
		child.stdin!.write(bytes.subarray(0, cut));
		await new Promise((resolve) => setTimeout(resolve, 50));
		child.stdin!.write(bytes.subarray(cut));
		assert.deepEqual(await output, [
			{ args: ["--session", "日本"], argv: ["--session", "日本"] },
			{ line: '{"id":"3"}' },
		]);
	});

	test("exits quietly when its host closes stdin without adopting it", async () => {
		const child = startEngine(writeEngineScript());
		const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
		child.stdin!.end();
		assert.equal(await exited, 0);
	});
});

describe("adopting a prewarmed engine child", () => {
	const launch = (overrides: Partial<EngineLaunch> = {}): EngineLaunch => ({
		...engineLaunch({ runtimeExecutable: "bun", cliPath: "cli.js", cwd: tmpdir(), interactiveEngine: true }),
		...overrides,
	});

	test("is refused, and nothing is adopted, when no child was prewarmed", () => {
		assert.equal(adoptPrewarmedEngine(launch(), ["--mode", "rpc"]), undefined);
	});

	const terminal = { stdinIsTTY: true, stdoutIsTTY: true, cpus: 8 };
	/** Prewarms the stand-in engine as `launch` starts it, and returns its pid once it runs. */
	async function prewarm(script: string, launch: EngineLaunch, basis?: PrewarmLaunchBasis): Promise<number> {
		prewarmInteractiveEngine([], { host: terminal, launch, basis });
		const pidFile = join(script, "..", "pid");
		await vi.waitFor(() => assert.ok(existsSync(pidFile) && readFileSync(pidFile, "utf8")), {
			timeout: ENGINE_START_OR_EXIT_WAIT_MS,
		});
		return Number(readFileSync(pidFile, "utf8"));
	}
	function running(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}
	const standIn = (script: string): EngineLaunch => ({
		command: "bun",
		args: [script],
		cwd: tmpdir(),
		env: Object.fromEntries(
			Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
		),
		detached: false,
	});

	test("tells a child prewarmed for a --no-session host, at its start, that it opens no session database", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-prewarm-"));
		tempDirs.push(dir);
		const script = join(dir, "engine.mjs");
		writeFileSync(
			script,
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(dir, "argv"))}, JSON.stringify(process.argv.slice(2)));\nprocess.stdin.resume();\n`,
		);
		const argvFile = join(dir, "argv");
		const startedArgv = async (hostArgs: string[]): Promise<string[]> => {
			prewarmInteractiveEngine(hostArgs, { host: terminal, launch: standIn(script) });
			await vi.waitFor(() => assert.ok(existsSync(argvFile)), { timeout: ENGINE_START_OR_EXIT_WAIT_MS });
			const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
			discardPrewarmedEngine();
			rmSync(argvFile);
			return argv;
		};
		assert.deepEqual(await startedArgv(["--no-session"]), [
			"--internal-engine-prewarm",
			"--internal-engine-prewarm-no-database",
		]);
		assert.deepEqual(await startedArgv([]), ["--internal-engine-prewarm"]);
	});

	test("adopts the child prewarmed with the very launch the host would start, and runs it as the host's engine", async () => {
		const script = writeEngineScript();
		const prewarmed = standIn(script);
		const pid = await prewarm(script, prewarmed);
		const bases: PrewarmLaunchBasis[] = [];
		const child = adoptPrewarmedEngine({ ...prewarmed, env: { ...prewarmed.env } }, ["--mode", "rpc"], (basis) =>
			bases.push(basis),
		);
		assert.ok(child, "the prewarmed child is adopted");
		children.push(child);
		assert.deepEqual(bases, ["unchanged"]);
		assert.deepEqual(JSON.parse(readFileSync(join(script, "..", "prewarm-argv"), "utf8")), [
			INTERACTIVE_ENGINE_PREWARM_FLAG,
		]);
		assert.equal(child.pid, pid);
		const output = readLines(child, 2);
		child.stdin!.write('{"id":"1"}\n');
		assert.deepEqual(await output, [{ args: ["--mode", "rpc"], argv: ["--mode", "rpc"] }, { line: '{"id":"1"}' }]);
	});

	test("tells its host that the prewarm carried environment the arguments or settings add", async () => {
		const script = writeEngineScript();
		const prewarmed = standIn(script);
		await prewarm(script, prewarmed, "derived");
		const bases: PrewarmLaunchBasis[] = [];
		const child = adoptPrewarmedEngine(prewarmed, ["--mode", "rpc"], (basis) => bases.push(basis));
		assert.ok(child, "the prewarmed child is adopted");
		children.push(child);
		assert.deepEqual(bases, ["derived"]);
		// Off Windows its host waits for its exit, so it writes its compile cache before that if it can.
		assert.deepEqual(
			JSON.parse(readFileSync(join(script, "..", "prewarm-argv"), "utf8")),
			process.platform === "win32"
				? [INTERACTIVE_ENGINE_PREWARM_FLAG]
				: [INTERACTIVE_ENGINE_PREWARM_FLAG, INTERACTIVE_ENGINE_PREWARM_WRITE_CACHE_FLAG],
		);
	});

	// The host's environment may change between the prewarm at its first line and the engine it settles on. A child
	// started with any other value of any variable must not run as its engine.
	test("stops, and adopts nothing, a child prewarmed with another value of one environment variable", async () => {
		const script = writeEngineScript();
		const prewarmed = standIn(script);
		const pid = await prewarm(script, prewarmed);
		const [name] = Object.keys(prewarmed.env);
		assert.ok(name);
		const settled = { ...prewarmed, env: { ...prewarmed.env, [name]: `${prewarmed.env[name]}-changed` } };
		assert.equal(adoptPrewarmedEngine(settled, ["--mode", "rpc"]), undefined);
		assert.equal(adoptPrewarmedEngine(prewarmed, ["--mode", "rpc"]), undefined, "the prewarmed child was discarded");
		await vi.waitFor(() => assert.equal(running(pid), false), { timeout: ENGINE_START_OR_EXIT_WAIT_MS });
	});

	test("a launch differs from another in any of its executable, arguments, directory, environment or group", () => {
		const base = launch();
		assert.equal(sameEngineLaunch(base, launch()), true);
		for (const changed of [
			launch({ command: "node" }),
			launch({ args: [...base.args, "--max-old-space-size=8192"] }),
			launch({ cwd: join(tmpdir(), "elsewhere") }),
			launch({ env: { ...base.env, ATOMIC_OFFLINE: "1" } }),
			launch({ env: { ...base.env, AI_AGENT: `${base.env.AI_AGENT}-changed` } }),
			launch({ env: Object.fromEntries(Object.entries(base.env).slice(1)) }),
			launch({ detached: !base.detached }),
		]) {
			assert.equal(sameEngineLaunch(base, changed), false);
		}
	});
});

describe("whether an interactive host prewarms its engine", () => {
	test("only an options-only invocation on a terminal, with a second CPU to load it on, is prewarmed", () => {
		const terminal = { stdinIsTTY: true, stdoutIsTTY: true, cpus: 8 };
		for (const args of [[], ["--model", "gpt"], ["--continue"]]) {
			assert.equal(shouldPrewarmInteractiveEngine(args, terminal), true, JSON.stringify(args));
		}
		for (const args of [
			["install", "npm:pkg"],
			["fix the bug"],
			["-p", "hi"],
			["--mode", "rpc"],
			["--help"],
			["--version"],
			["--internal-engine-bootstrap", "x"],
		]) {
			assert.equal(shouldPrewarmInteractiveEngine(args, terminal), false, JSON.stringify(args));
		}
		assert.equal(shouldPrewarmInteractiveEngine([], { ...terminal, stdinIsTTY: false }), false);
		assert.equal(shouldPrewarmInteractiveEngine([], { ...terminal, stdoutIsTTY: false }), false);
		assert.equal(shouldPrewarmInteractiveEngine([], { ...terminal, cpus: 1 }), false);
	});
});
