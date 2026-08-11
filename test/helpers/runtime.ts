/**
 * Node replacements for the Bun globals the root suites used.
 *
 * Every helper here exists because the Bun API it replaces has no faithful
 * one-line Node equivalent, or because the obvious equivalent differs in a way
 * that fails silently:
 *
 *   Bun.write        creates missing parent directories; fs.writeFile does not.
 *   Bun.spawnSync    returns `exitCode`; node returns `status`.
 *   Bun.spawn        exposes `.exited` and web ReadableStream stdio; node does not.
 *   Bun.file(p)      is lazy; the readers here are eager, which is what every
 *                    call site already did by awaiting immediately.
 *
 * Nothing here is a test utility in the assertion sense — the suites keep using
 * node:assert/strict.
 */
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** `Bun.sleep(ms)`. */
export function sleep(milliseconds: number): Promise<void> {
	return delay(milliseconds);
}

/** `import.meta.dir`, which Node does not define. */
export function moduleDir(importMetaUrl: string): string {
	return dirname(fileURLToPath(importMetaUrl));
}

let cachedBunExecutable: string | undefined;

/**
 * The Bun binary.
 *
 * Under Bun these suites used `process.execPath`, which silently meant "the Bun
 * that is running me". Under vitest `process.execPath` is Node, so every child
 * that runs a `.ts` file, `bun test`, `bun run`, or a Bun-specific `-e` script
 * has to name Bun explicitly. Resolution order is the override, then PATH.
 *
 * Bun is a declared engine of this repository (package.json `engines.bun`) and
 * is still what compiles the release binaries, so a missing binary is a broken
 * environment and is reported as one rather than skipped past.
 */
export function bunExecutable(): string {
	if (cachedBunExecutable !== undefined) return cachedBunExecutable;
	const override = process.env.ATOMIC_BUN_EXECUTABLE;
	if (override && existsSync(override)) {
		cachedBunExecutable = override;
		return cachedBunExecutable;
	}
	const resolved = resolveExecutable("bun");
	if (resolved) {
		cachedBunExecutable = resolved;
		return cachedBunExecutable;
	}
	throw new Error(
		"Bun was not found on PATH. It remains a declared engine of this repository: it compiles the " +
			"release binaries and runs scripts/*.ts and the Bun-hosted test fixtures. " +
			"Install Bun >=1.3.14 or set ATOMIC_BUN_EXECUTABLE.",
	);
}

/**
 * Locate an executable the way a shell would, returning undefined when it is not
 * on PATH.
 *
 * This exists because `Bun.spawn` throws *synchronously* when the binary is
 * missing while Node reports ENOENT asynchronously on the child's `error` event.
 * Shipped code catches the synchronous throw to attach the error code, and an
 * async-only failure would slip past that catch and lose it.
 */
function resolveExecutable(command: string): string | undefined {
	if (command.includes("/") || command.includes("\\")) return existsSync(command) ? command : undefined;
	const extensions =
		process.platform === "win32"
			? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((part) => part !== "")
			: [];
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		const base = join(directory, command);
		// PATHEXT first on Windows. npm ships as both `npm` (a POSIX shell script
		// that Windows cannot exec) and `npm.cmd` beside it, so preferring the
		// extensionless match picks the one that fails with ENOENT.
		for (const extension of extensions) if (existsSync(base + extension)) return base + extension;
		if (existsSync(base)) return base;
	}
	return undefined;
}

/** `await Bun.file(path).text()`. */
export function readText(path: string): Promise<string> {
	return readFile(path, "utf8");
}

/** `await Bun.file(path).json()`. */
export async function readJson<T = unknown>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

/** `await Bun.file(path).exists()`. */
export function fileExists(path: string): Promise<boolean> {
	return readFile(path)
		.then(() => true)
		.catch(() => false);
}

/**
 * `Bun.write(path, data)`.
 *
 * The `mkdir` is the whole point: `Bun.write` creates missing parents and
 * `fs.writeFile` throws ENOENT, so a codemod that reached for `writeFile`
 * directly would convert working setup code into a failure at an unrelated line.
 */
export async function writeFileEnsuringDir(path: string, data: string | Uint8Array | ArrayBuffer): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, data instanceof ArrayBuffer ? new Uint8Array(data) : data);
}

/** Bun's stdio option values, as the call sites spell them. */
type StdioOption = "pipe" | "inherit" | "ignore" | null | undefined;

/**
 * Bun additionally accepts raw bytes as `stdin`, which it feeds to the child.
 * Node spells that `input` instead, and silently treats an unrecognised stdio
 * entry as a pipe nobody writes to -- a child reading stdin then blocks forever
 * rather than failing, which is exactly how this arrived as a hung suite.
 */
type StdinOption = StdioOption | Buffer | Uint8Array | string;

interface BunSpawnOptions {
	cmd?: readonly string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
	stdin?: StdinOption;
	stdout?: StdioOption;
	stderr?: StdioOption;
	timeout?: number;
}

function isStdinData(value: StdinOption): value is Buffer | Uint8Array | string {
	return typeof value === "string" || ArrayBuffer.isView(value);
}

function stdio(value: StdioOption, fallback: "pipe" | "inherit" | "ignore"): "pipe" | "inherit" | "ignore" {
	return value === null || value === undefined ? fallback : value;
}

/**
 * Bun drops env keys whose value is `undefined`; Node stringifies them to
 * `"undefined"`. One test uses that difference deliberately to unset
 * GITHUB_STEP_SUMMARY for a child, so the erasure has to be reproduced.
 */
function environment(env: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv | undefined {
	if (!env) return undefined;
	const resolved: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) if (value !== undefined) resolved[key] = value;
	return resolved;
}

function normalize(
	first: readonly string[] | BunSpawnOptions,
	second: BunSpawnOptions | undefined,
): { command: string; args: string[]; options: BunSpawnOptions } {
	const options = (Array.isArray(first) ? (second ?? {}) : (first as BunSpawnOptions)) ?? {};
	const cmd = Array.isArray(first) ? (first as readonly string[]) : ((first as BunSpawnOptions).cmd ?? []);
	if (cmd.length === 0) throw new Error("spawn requires a non-empty command");
	return { command: cmd[0] as string, args: [...cmd.slice(1)], options };
}

/** What `Bun.spawnSync` returns, restricted to the fields the suites read. */
export interface SyncSpawnResult {
	exitCode: number;
	signalCode: NodeJS.Signals | null;
	stdout: Buffer;
	stderr: Buffer;
	success: boolean;
}

/**
 * `Bun.spawnSync`, in both shapes the suites call it: an argv array with options,
 * or a single object carrying `cmd`.
 *
 * `stdout`/`stderr` stay Buffers so the existing `.toString()` at every call site
 * keeps working, and `status` is renamed to `exitCode` — the one shape difference
 * that would otherwise turn every `assert.equal(result.exitCode, 0)` into a
 * comparison against `undefined`, which passes for no reason on a failed child.
 */
export function spawnSyncCollect(
	first: readonly string[] | BunSpawnOptions,
	second?: BunSpawnOptions,
): SyncSpawnResult {
	const { command, args, options } = normalize(first, second);
	const input = isStdinData(options.stdin) ? options.stdin : undefined;
	const result = nodeSpawnSync(command, args, {
		cwd: options.cwd,
		env: environment(options.env),
		timeout: options.timeout,
		input,
		stdio: [
			input === undefined ? stdio(options.stdin as StdioOption, "ignore") : "pipe",
			stdio(options.stdout, "pipe"),
			stdio(options.stderr, "pipe"),
		],
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	const exitCode = result.status ?? (result.signal ? 128 : 1);
	return {
		exitCode,
		signalCode: result.signal ?? null,
		stdout: result.stdout ?? Buffer.alloc(0),
		stderr: result.stderr ?? Buffer.alloc(0),
		success: exitCode === 0,
	};
}

/**
 * Bun's stdin is a `FileSink`, whose `flush()` pushes buffered bytes to the
 * child. Node's is a `Writable` that has already handed the bytes to the pipe,
 * so `flush()` only has to wait for backpressure to clear.
 */
export interface SpawnedStdin extends NodeJS.WritableStream {
	flush(): Promise<void>;
}

/**
 * A child's byte stream.
 *
 * Kept as a named alias because `TextDecoderStream` is typed against
 * `BufferSource` rather than `Uint8Array`, so `pipeThrough` needs one deliberate
 * bridge (`decodeStream` below) instead of a cast at every call site.
 */
export type ByteStream = ReadableStream<Uint8Array<ArrayBufferLike>>;

/** The `Bun.spawn` subprocess surface these suites use. */
export interface SpawnedProcess {
	readonly pid: number | undefined;
	readonly stdin: SpawnedStdin | null;
	readonly stdout: ByteStream | null;
	readonly stderr: ByteStream | null;
	readonly exited: Promise<number>;
	readonly exitCode: number | null;
	kill(signal?: NodeJS.Signals | number): void;
	unref(): void;
}

/**
 * `Bun.spawn`.
 *
 * stdout/stderr are converted to web `ReadableStream`s because the call sites
 * consume them with `.pipeThrough(new TextDecoderStream())` and
 * `new Response(stream).text()` — both of which a Node `Readable` does not
 * support. `exited` reproduces Bun's promise; Node only emits an event.
 */
export function spawnProcess(first: readonly string[] | BunSpawnOptions, second?: BunSpawnOptions): SpawnedProcess {
	const { command, args, options } = normalize(first, second);
	// Bun refuses a missing binary synchronously; reproduce that so a caller's
	// try/catch around the spawn still sees an ENOENT it can classify.
	const executable = resolveExecutable(command);
	if (executable === undefined) {
		throw Object.assign(new Error(`spawn ${command} ENOENT`), {
			code: "ENOENT",
			errno: -2,
			syscall: `spawn ${command}`,
			path: command,
		});
	}
	// Windows ships `npm`, `npx` and friends as `.cmd` shims. Bun resolved and ran
	// those itself; Node will not -- a bare name is not on its search path, and
	// since Node 20.12 (CVE-2024-27980) it refuses to exec a `.cmd` or `.bat`
	// without a shell. Spawn the resolved path, through a shell only for shims.
	const isShim = /\.(?:cmd|bat)$/iu.test(executable);
	const commandLine = isShim ? `"${executable}"` : executable;
	const child = nodeSpawn(commandLine, args, {
		cwd: options.cwd,
		env: environment(options.env),
		timeout: options.timeout,
		detached: (options as { detached?: boolean }).detached,
		shell: isShim,
		stdio: [
			stdio(options.stdin as StdioOption, "ignore"),
			stdio(options.stdout, "pipe"),
			stdio(options.stderr, "inherit"),
		],
	});
	let exitCode: number | null = null;
	const exited = new Promise<number>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code, signal) => {
			exitCode = code ?? (signal ? 128 : 0);
			resolve(exitCode);
		});
	});
	const web = (stream: Readable | null): ByteStream | null =>
		stream === null ? null : (Readable.toWeb(stream) as unknown as ByteStream);
	const stdin: SpawnedStdin | null =
		child.stdin === null
			? null
			: Object.assign(child.stdin, {
					flush: (): Promise<void> =>
						child.stdin?.writableNeedDrain === true
							? new Promise<void>((resolve) => child.stdin?.once("drain", () => resolve()))
							: Promise.resolve(),
				});
	return {
		pid: child.pid,
		stdin,
		stdout: web(child.stdout),
		stderr: web(child.stderr),
		exited,
		get exitCode() {
			return exitCode;
		},
		kill: (signal) => {
			child.kill(signal as NodeJS.Signals);
		},
		unref: () => child.unref(),
	};
}

/**
 * Decode a child's byte stream as text.
 *
 * `TextDecoderStream` is declared as `ReadableWritablePair<string, BufferSource>`
 * while a child stream is `Uint8Array`, so `pipeThrough` needs a bridge. Doing it
 * once here keeps the assertion out of every harness that reads a child.
 */
export function decodeStream(stream: ByteStream): ReadableStream<string> {
	return stream.pipeThrough(
		new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array<ArrayBufferLike>>,
	);
}

/** Drain a byte stream to a string, as `new Response(stream).text()` did. */
export async function readStreamText(stream: ByteStream | null): Promise<string> {
	if (!stream) return "";
	const reader = decodeStream(stream).getReader();
	let text = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		text += value;
	}
	return text;
}

/**
 * Install the minimum `Bun` global that shipped runtime code needs, for the one
 * test file that exercises such a module in-process.
 *
 * `packages/web-access/subprocess.ts` is product code: it calls `Bun.spawn` and
 * `Bun.sleep` unguarded, because it only ever runs inside the Bun-compiled
 * binary. This migration deliberately does not touch it. Its unit tests, though,
 * import it directly, and under vitest there is no `Bun` global to call.
 *
 * The alternative was to re-exec that whole file under Bun, which would have
 * collapsed its five distinct test names into one wrapper assertion — a real
 * loss of coverage to work around a runtime detail. Supplying the two primitives
 * it uses keeps all five names and all five assertions, and what they actually
 * cover (bounded draining, the byte cap, the timeout, and the kill path) is
 * unchanged. What it no longer covers is Bun's own spawn implementation.
 *
 * Scope is one vitest worker for one file: vitest isolates test files by default.
 */
export function installBunGlobal(): void {
	const target = globalThis as { Bun?: unknown };
	if (target.Bun !== undefined) return;
	target.Bun = { spawn: spawnProcess, spawnSync: spawnSyncCollect, sleep };
}

/**
 * Run `body` with `process.execPath` reporting the Bun binary, then restore it.
 *
 * Some shipped code derives the runtime to spawn from `process.execPath` and
 * only treats a `.ts` entry point as runnable when that path is a Bun runtime
 * (packages/subagents/src/runs/shared/pi-spawn.ts). Under Bun the suite supplied
 * that implicitly. Under vitest it has to be stated, or the spawn silently falls
 * back to resolving `atomic` on PATH and the test measures the wrong process.
 */
export async function withBunRuntime<T>(body: () => Promise<T>): Promise<T> {
	const original = process.execPath;
	Object.defineProperty(process, "execPath", { value: bunExecutable(), configurable: true, writable: true });
	try {
		return await body();
	} finally {
		Object.defineProperty(process, "execPath", { value: original, configurable: true, writable: true });
	}
}
