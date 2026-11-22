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
	INTERACTIVE_ENGINE_PREWARM_DEFAULT_MODEL_API_FLAG,
	INTERACTIVE_ENGINE_PREWARM_HANDOFF_FLAG,
	INTERACTIVE_ENGINE_PREWARM_WRITE_CACHE_FLAG,
	PREWARM_HOST_ARGUMENTS_MAX_LENGTH,
	type PrewarmLaunchBasis,
	prewarmHostArguments,
	prewarmInteractiveEngine,
	sameEngineLaunch,
	shouldPrewarmInteractiveEngine,
	waitForPrewarmedEngineReady,
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
		`import { renameSync, writeFileSync } from "node:fs";\n` +
			`import { dirname, join } from "node:path";\n` +
			`import { fileURLToPath } from "node:url";\n` +
			`const dir = dirname(fileURLToPath(import.meta.url));\n` +
			`const publish = (name, text) => { const target = join(dir, name); writeFileSync(target + ".tmp", text); renameSync(target + ".tmp", target); };\n` +
			`publish("prewarm-argv", JSON.stringify(process.argv.slice(2)));\n` +
			`const hasHandoffFlag = process.argv.slice(2).some((arg) => arg.startsWith("--internal-engine-prewarm-handoff="));\n` +
			`if (hasHandoffFlag) {\n` +
			`  const origWrite = process.stdout.write.bind(process.stdout);\n` +
			`  let readyPublished = false;\n` +
			`  process.stdout.write = (chunk, ...rest) => {\n` +
			`    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");\n` +
			`    if (!readyPublished && text.includes('"prewarm_ready"')) {\n` +
			`      readyPublished = true;\n` +
			`      return origWrite(chunk, () => publish("pid", String(process.pid)));\n` +
			`    }\n` +
			`    return origWrite(chunk, ...rest);\n` +
			`  };\n` +
			`} else {\n` +
			`  publish("pid", String(process.pid));\n` +
			`}\n` +
			`import { readPrewarmedEngineArgs } from ${JSON.stringify(prewarm)};\n` +
			`import { attachJsonlLineReader } from ${JSON.stringify(jsonl)};\n` +
			"const args = await readPrewarmedEngineArgs();\n" +
			'process.stdout.write(JSON.stringify({ args, argv: process.argv.slice(2), env: { ATOMIC_DEBUG_SETTING: process.env.ATOMIC_DEBUG_SETTING ?? null, HTTP_PROXY: process.env.HTTP_PROXY ?? null, HTTPS_PROXY: process.env.HTTPS_PROXY ?? null, OTHER_TEST_VAR: process.env.OTHER_TEST_VAR ?? null } }) + "\\n");\n' +
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
		const lines = await output;
		assert.deepEqual(
			lines.map((entry) => ("args" in entry ? { args: entry.args, argv: entry.argv } : entry)),
			[
				{ args: ["--mode", "rpc", "--session", "é"], argv: ["--mode", "rpc", "--session", "é"] },
				{ line: '{"id":"1"}' },
				{ line: '{"id":"2"}' },
			],
		);
	});

	test("reads a handshake split anywhere, even inside a character", async () => {
		const child = startEngine(writeEngineScript());
		const output = readLines(child, 2);
		const bytes = Buffer.from(`${JSON.stringify({ args: ["--session", "日本"] })}\n{"id":"3"}\n`, "utf8");
		const cut = bytes.indexOf(Buffer.from("本", "utf8")) + 1;
		child.stdin!.write(bytes.subarray(0, cut));
		await new Promise((resolve) => setTimeout(resolve, 50));
		child.stdin!.write(bytes.subarray(cut));
		const lines = await output;
		assert.deepEqual(
			lines.map((entry) => ("args" in entry ? { args: entry.args, argv: entry.argv } : entry)),
			[{ args: ["--session", "日本"], argv: ["--session", "日本"] }, { line: '{"id":"3"}' }],
		);
	});

	test("reconciles only settings-derived environment keys from the handshake and ignores other keys", async () => {
		const child = startEngine(writeEngineScript());
		const output = readLines(child, 2);
		child.stdin!.write(
			`${JSON.stringify({
				args: ["--mode", "rpc"],
				env: {
					ATOMIC_DEBUG_SETTING: "1",
					HTTP_PROXY: "http://127.0.0.1:8888",
					HTTPS_PROXY: null,
					OTHER_TEST_VAR: "injected",
				},
			})}\n{"id":"4"}\n`,
		);
		const [first, second] = await output;
		assert.deepEqual(first?.args, ["--mode", "rpc"]);
		assert.deepEqual(first?.env, {
			ATOMIC_DEBUG_SETTING: "1",
			HTTP_PROXY: "http://127.0.0.1:8888",
			HTTPS_PROXY: null,
			OTHER_TEST_VAR: null,
		});
		assert.deepEqual(second, { line: '{"id":"4"}' });
	});

	test("exits quietly when its host closes stdin without adopting it", async () => {
		const child = startEngine(writeEngineScript());
		const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
		child.stdin!.end();
		assert.equal(await exited, 0);
	});

	test("writes nothing to stdout before adoption when started without the opt-in handoff flag (older host compatibility)", async () => {
		const child = startEngine(writeEngineScript());
		let leaked = "";
		child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
			leaked += chunk;
		});
		const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(leaked, "", "an older host does not expect prewarm stdout frames");
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
		// Let the parent's I/O poll ingest the already-flushed readiness line from the child's stdout pipe.
		await new Promise((resolve) => setTimeout(resolve, 50));
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

	test("tells a child prewarmed for a --no-session host, at its start, that it opens no session database, and gives it its host's arguments", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-prewarm-"));
		tempDirs.push(dir);
		const script = join(dir, "engine.mjs");
		writeFileSync(
			script,
			`import { renameSync, writeFileSync } from "node:fs";\n` +
				`import { dirname, join } from "node:path";\n` +
				`import { fileURLToPath } from "node:url";\n` +
				`const target = join(dirname(fileURLToPath(import.meta.url)), "argv");\n` +
				`writeFileSync(target + ".tmp", JSON.stringify(process.argv.slice(2)));\n` +
				`renameSync(target + ".tmp", target);\n` +
				`process.stdin.resume();\n`,
		);
		const argvFile = join(dir, "argv");
		/** The flags a child was started with, the one that carries the host's arguments by its name. */
		const flagsOf = (argv: string[]) => argv.map((arg) => arg.replace(/=.*$/s, ""));
		const startedArgv = async (hostArgs: string[], basis?: PrewarmLaunchBasis): Promise<string[]> => {
			prewarmInteractiveEngine(hostArgs, { host: terminal, launch: standIn(script), basis });
			await vi.waitFor(() => assert.ok(existsSync(argvFile)), { timeout: ENGINE_START_OR_EXIT_WAIT_MS });
			const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
			discardPrewarmedEngine();
			rmSync(argvFile);
			return argv;
		};
		const DEFAULT_MODEL_API = INTERACTIVE_ENGINE_PREWARM_DEFAULT_MODEL_API_FLAG;
		const HANDOFF = INTERACTIVE_ENGINE_PREWARM_HANDOFF_FLAG;
		assert.deepEqual(flagsOf(await startedArgv(["--no-session"])), [
			"--internal-engine-prewarm",
			"--internal-engine-prewarm-no-database",
			DEFAULT_MODEL_API,
			HANDOFF,
		]);
		assert.deepEqual(flagsOf(await startedArgv([])), ["--internal-engine-prewarm", DEFAULT_MODEL_API, HANDOFF]);
		// The engine reads the no-database marker as its second argument; the other flags come after it.
		assert.deepEqual(
			flagsOf(await startedArgv(["--no-session"], "derived")),
			process.platform === "win32"
				? ["--internal-engine-prewarm", "--internal-engine-prewarm-no-database", DEFAULT_MODEL_API, HANDOFF]
				: [
						"--internal-engine-prewarm",
						"--internal-engine-prewarm-no-database",
						"--internal-engine-prewarm-write-cache",
						DEFAULT_MODEL_API,
						HANDOFF,
					],
		);
		// The child is given the host's arguments, whatever they are, to read as the command line reads them.
		for (const hostArgs of [
			[],
			["--model", "gpt-5"],
			["--approve", "--", "- summarize this", "--model"],
			["--approve", "-n", "review", 'fix the failing test with "quotes", ünïcödé and \\ back\\slashes', "@src/a.ts"],
		])
			assert.deepEqual(prewarmHostArguments(await startedArgv(hostArgs)), hostArgs, hostArgs.join(" "));
		// Not arguments too long to pass on: that child loads nothing before its host takes it over.
		const longMessage = "x".repeat(PREWARM_HOST_ARGUMENTS_MAX_LENGTH);
		const argv = await startedArgv(["--approve", longMessage]);
		assert.deepEqual(flagsOf(argv), ["--internal-engine-prewarm", HANDOFF]);
		assert.equal(prewarmHostArguments(argv), undefined);
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
		const argv = JSON.parse(readFileSync(join(script, "..", "prewarm-argv"), "utf8")) as string[];
		assert.deepEqual(
			argv.map((arg) => arg.replace(/=.*$/s, "")),
			[
				INTERACTIVE_ENGINE_PREWARM_FLAG,
				INTERACTIVE_ENGINE_PREWARM_DEFAULT_MODEL_API_FLAG,
				INTERACTIVE_ENGINE_PREWARM_HANDOFF_FLAG,
			],
		);
		assert.deepEqual(prewarmHostArguments(argv), []);
		assert.equal(child.pid, pid);
		const output = readLines(child, 2);
		child.stdin!.write('{"id":"1"}\n');
		const lines = await output;
		assert.deepEqual(
			lines.map((entry) => ("args" in entry ? { args: entry.args, argv: entry.argv } : entry)),
			[{ args: ["--mode", "rpc"], argv: ["--mode", "rpc"] }, { line: '{"id":"1"}' }],
		);
	});

	test("adopts the prewarmed child across a settings-derived environment edit and reconciles its env on handshake", async () => {
		const script = writeEngineScript();
		const baseEnv = { ...standIn(script).env };
		delete baseEnv.HTTP_PROXY;
		delete baseEnv.HTTPS_PROXY;
		const prewarmed: EngineLaunch = {
			...standIn(script),
			env: {
				...baseEnv,
				ATOMIC_DEBUG_SETTING: "0",
				HTTP_PROXY: "http://127.0.0.1:9",
				HTTPS_PROXY: "http://127.0.0.1:9",
			},
		};
		const pid = await prewarm(script, prewarmed, "unchanged");
		const settledEnv = { ...baseEnv, ATOMIC_DEBUG_SETTING: "1", HTTPS_PROXY: "http://127.0.0.1:10" };
		const bases: PrewarmLaunchBasis[] = [];
		const child = adoptPrewarmedEngine({ ...prewarmed, env: settledEnv }, ["--mode", "rpc"], (basis) =>
			bases.push(basis),
		);
		assert.ok(child, "the prewarmed child is adopted despite settings-env changes");
		children.push(child);
		assert.equal(child.pid, pid);
		assert.deepEqual(bases, ["derived"]);
		const output = readLines(child, 2);
		child.stdin!.write('{"id":"1"}\n');
		const [first, second] = await output;
		assert.deepEqual(first?.args, ["--mode", "rpc"]);
		assert.deepEqual(first?.env, {
			ATOMIC_DEBUG_SETTING: "1",
			HTTP_PROXY: null,
			HTTPS_PROXY: "http://127.0.0.1:10",
			OTHER_TEST_VAR: null,
		});
		assert.deepEqual(second, { line: '{"id":"1"}' });
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
			(JSON.parse(readFileSync(join(script, "..", "prewarm-argv"), "utf8")) as string[]).map((arg) =>
				arg.replace(/=.*$/s, ""),
			),
			process.platform === "win32"
				? [
						INTERACTIVE_ENGINE_PREWARM_FLAG,
						INTERACTIVE_ENGINE_PREWARM_DEFAULT_MODEL_API_FLAG,
						INTERACTIVE_ENGINE_PREWARM_HANDOFF_FLAG,
					]
				: [
						INTERACTIVE_ENGINE_PREWARM_FLAG,
						INTERACTIVE_ENGINE_PREWARM_WRITE_CACHE_FLAG,
						INTERACTIVE_ENGINE_PREWARM_DEFAULT_MODEL_API_FLAG,
						INTERACTIVE_ENGINE_PREWARM_HANDOFF_FLAG,
					],
		);
	});

	test("discards a prewarmed child from a different build even when launch and environment are identical", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-prewarm-diffbuild-"));
		tempDirs.push(dir);
		const script = join(dir, "diff-build.mjs");
		const pidFile = join(dir, "pid");
		writeFileSync(
			script,
			`import { renameSync, writeFileSync } from "node:fs";\n` +
				`const flag = process.argv.slice(2).find((a) => a.startsWith("${INTERACTIVE_ENGINE_PREWARM_HANDOFF_FLAG}="));\n` +
				`const nonce = flag ? flag.slice(flag.indexOf("=") + 1) : "";\n` +
				`process.stdout.write(JSON.stringify({ type: "prewarm_ready", nonce, build: "v1:9.9.9:other-build", envHandoff: true }) + "\\n", () => {\n` +
				`  writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid));\n` +
				`  renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});\n` +
				`});\n` +
				`process.stdin.resume();\n`,
		);
		const prewarmed = standIn(script);
		prewarmInteractiveEngine([], { host: terminal, launch: prewarmed, buildIdentity: "v1:0.0.0:host-build" });
		await vi.waitFor(() => assert.ok(existsSync(pidFile)), { timeout: ENGINE_START_OR_EXIT_WAIT_MS });
		await new Promise((resolve) => setTimeout(resolve, 50));
		const pid = Number(readFileSync(pidFile, "utf8"));
		assert.equal(adoptPrewarmedEngine({ ...prewarmed, env: { ...prewarmed.env } }, ["--mode", "rpc"]), undefined);
		await vi.waitFor(() => assert.equal(running(pid), false), { timeout: ENGINE_START_OR_EXIT_WAIT_MS });
	});

	test("discards a prewarmed child that never advertises readiness (older release or slow start)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-prewarm-oldchild-"));
		tempDirs.push(dir);
		const script = join(dir, "silent-child.mjs");
		const pidFile = join(dir, "pid");
		writeFileSync(
			script,
			`import { renameSync, writeFileSync } from "node:fs";\n` +
				`writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid));\n` +
				`renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});\n` +
				`process.stdin.resume();\n`,
		);
		const prewarmed = standIn(script);
		prewarmInteractiveEngine([], { host: terminal, launch: prewarmed, buildIdentity: "v1:0.0.0:host-build" });
		await vi.waitFor(() => assert.ok(existsSync(pidFile)), { timeout: ENGINE_START_OR_EXIT_WAIT_MS });
		const pid = Number(readFileSync(pidFile, "utf8"));
		assert.equal(adoptPrewarmedEngine({ ...prewarmed, env: { ...prewarmed.env } }, ["--mode", "rpc"]), undefined);
		await vi.waitFor(() => assert.equal(running(pid), false), { timeout: ENGINE_START_OR_EXIT_WAIT_MS });
	});

	test.each([
		{
			name: "wrong nonce",
			line: 'JSON.stringify({ type: "prewarm_ready", nonce: "wrong", build: "v1:0.0.0:host-build", envHandoff: true }) + "\\n"',
		},
		{
			name: "envHandoff false",
			line: 'JSON.stringify({ type: "prewarm_ready", nonce, build: "v1:0.0.0:host-build", envHandoff: false }) + "\\n"',
		},
		{
			name: "wrong type",
			line: 'JSON.stringify({ type: "other", nonce, build: "v1:0.0.0:host-build", envHandoff: true }) + "\\n"',
		},
		{ name: "malformed JSON", line: '"not-json\\n"' },
		{ name: "oversized line without newline", line: '"x".repeat(5000)' },
	])("discards a prewarmed child whose readiness output has $name", async ({ line }) => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-prewarm-badready-"));
		tempDirs.push(dir);
		const script = join(dir, "bad-ready.mjs");
		const pidFile = join(dir, "pid");
		writeFileSync(
			script,
			`import { renameSync, writeFileSync } from "node:fs";\n` +
				`const flag = process.argv.slice(2).find((a) => a.startsWith("${INTERACTIVE_ENGINE_PREWARM_HANDOFF_FLAG}="));\n` +
				`const nonce = flag ? flag.slice(flag.indexOf("=") + 1) : "";\n` +
				`process.stdout.write(${line}, () => {\n` +
				`  writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid));\n` +
				`  renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});\n` +
				`});\n` +
				`process.stdin.resume();\n`,
		);
		const prewarmed = standIn(script);
		prewarmInteractiveEngine([], { host: terminal, launch: prewarmed, buildIdentity: "v1:0.0.0:host-build" });
		await vi.waitFor(() => assert.ok(existsSync(pidFile)), { timeout: ENGINE_START_OR_EXIT_WAIT_MS });
		await new Promise((resolve) => setTimeout(resolve, 50));
		const pid = Number(readFileSync(pidFile, "utf8"));
		assert.equal(adoptPrewarmedEngine({ ...prewarmed, env: { ...prewarmed.env } }, ["--mode", "rpc"]), undefined);
		await vi.waitFor(() => assert.equal(running(pid), false), { timeout: ENGINE_START_OR_EXIT_WAIT_MS });
	});

	test("adopts a child whose CRLF readiness line arrives split across chunks and preserves trailing stdout bytes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-prewarm-splitready-"));
		tempDirs.push(dir);
		const script = join(dir, "split-ready.mjs");
		const pidFile = join(dir, "pid");
		writeFileSync(
			script,
			`import { renameSync, writeFileSync } from "node:fs";\n` +
				`const flag = process.argv.slice(2).find((a) => a.startsWith("${INTERACTIVE_ENGINE_PREWARM_HANDOFF_FLAG}="));\n` +
				`const nonce = flag ? flag.slice(flag.indexOf("=") + 1) : "";\n` +
				`const build = "v1:0.0.0:日本語-build";\n` +
				`const frame = Buffer.from(JSON.stringify({ type: "prewarm_ready", nonce, build, envHandoff: true }) + "\\r\\n" + JSON.stringify({ after: "kept" }) + "\\n", "utf8");\n` +
				`const cut = frame.indexOf(Buffer.from("本", "utf8")) + 1;\n` +
				`process.stdout.write(frame.subarray(0, cut));\n` +
				`setTimeout(() => {\n` +
				`  process.stdout.write(frame.subarray(cut), () => {\n` +
				`    writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid));\n` +
				`    renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});\n` +
				`  });\n` +
				`}, 20);\n` +
				`process.stdin.resume();\n`,
		);
		const prewarmed = standIn(script);
		prewarmInteractiveEngine([], { host: terminal, launch: prewarmed, buildIdentity: "v1:0.0.0:日本語-build" });
		await vi.waitFor(() => assert.ok(existsSync(pidFile)), { timeout: ENGINE_START_OR_EXIT_WAIT_MS });
		await new Promise((resolve) => setTimeout(resolve, 50));
		const child = adoptPrewarmedEngine({ ...prewarmed, env: { ...prewarmed.env } }, ["--mode", "rpc"]);
		assert.ok(child, "the split CRLF ready frame was accepted");
		children.push(child);
		const [trailing] = await readLines(child, 1);
		assert.deepEqual(trailing, { after: "kept" });
	});

	test("waitForPrewarmedEngineReady wakes as soon as a delayed child announces and stays bounded for a silent child", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-prewarm-waitready-"));
		tempDirs.push(dir);
		const delayedScript = join(dir, "delayed.mjs");
		writeFileSync(
			delayedScript,
			`const flag = process.argv.slice(2).find((a) => a.startsWith("${INTERACTIVE_ENGINE_PREWARM_HANDOFF_FLAG}="));\n` +
				`const nonce = flag ? flag.slice(flag.indexOf("=") + 1) : "";\n` +
				`setTimeout(() => {\n` +
				`  process.stdout.write(JSON.stringify({ type: "prewarm_ready", nonce, build: "v1:0.0.0:delayed", envHandoff: true }) + "\\n");\n` +
				`}, 40);\n` +
				`process.stdin.resume();\n`,
		);
		const delayedLaunch = standIn(delayedScript);
		prewarmInteractiveEngine([], { host: terminal, launch: delayedLaunch, buildIdentity: "v1:0.0.0:delayed" });
		await waitForPrewarmedEngineReady(ENGINE_START_OR_EXIT_WAIT_MS);
		const adopted = adoptPrewarmedEngine({ ...delayedLaunch, env: { ...delayedLaunch.env } }, ["--mode", "rpc"]);
		assert.ok(adopted, "delayed child adopted after waiting for readiness");
		children.push(adopted);

		const silentScript = join(dir, "silent.mjs");
		writeFileSync(silentScript, "process.stdin.resume();\n");
		const silentLaunch = standIn(silentScript);
		prewarmInteractiveEngine([], { host: terminal, launch: silentLaunch, buildIdentity: "v1:0.0.0:host" });
		const t0 = performance.now();
		await waitForPrewarmedEngineReady(60);
		assert.ok(performance.now() - t0 < 2_000, "bounded wait returned without stalling");
		assert.equal(
			adoptPrewarmedEngine({ ...silentLaunch, env: { ...silentLaunch.env } }, ["--mode", "rpc"]),
			undefined,
		);
	});

	// The host's environment may change between the prewarm at its first line and the engine it settles on. A child
	// started with any other value of any variable must not run as its engine.
	test("stops, and adopts nothing, a child prewarmed with another value of one environment variable", async () => {
		const script = writeEngineScript();
		const prewarmed = standIn(script);
		const pid = await prewarm(script, prewarmed);
		const name = Object.keys(prewarmed.env).find(
			(key) => key !== "ATOMIC_DEBUG_SETTING" && key !== "HTTP_PROXY" && key !== "HTTPS_PROXY",
		);
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
