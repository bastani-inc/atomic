import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
	access,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	readlink,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/index.ts";
import { FileMutationConflict } from "../src/core/tools/file-mutation-coordinator.ts";
import * as atomic from "../src/index.ts";

const guest = { dir: "", race: false, dangling: false };

// The real SDK resolves paths on the host, independently of the example's path import.
// Project only operation operands back into the fixture's guest namespace, not tool logic.
function toolPathToGuest(toolPath: string, hostPaths = path): string {
	assert.ok(hostPaths.isAbsolute(toolPath), `Expected an absolute tool path: ${toolPath}`);
	const suffix = hostPaths.relative(hostPaths.parse(toolPath).root, toolPath);
	return path.posix.join("/", ...suffix.split(hostPaths.sep));
}

function guestOperations<T extends object>(operations: T): T {
	return Object.fromEntries(
		Object.entries(operations).map(([name, operation]) => [
			name,
			(filePath: string, ...args: unknown[]) => operation(toolPathToGuest(filePath), ...args),
		]),
	) as T;
}

function guestToHost(guestPath: string, hostDir: string, hostPaths = path): string {
	for (const root of ["/workspace", "/data/workspace", "/native"]) {
		if (guestPath === root || guestPath.startsWith(`${root}/`)) {
			const suffix = path.posix.relative(root, guestPath);
			assert.ok(suffix !== ".." && !suffix.startsWith("../"), `Escaping guest path: ${guestPath}`);
			return hostPaths.join(hostDir, root === "/native" ? "native" : "", ...suffix.split("/"));
		}
	}
	throw new Error(`Unmapped guest path: ${guestPath}`);
}

function fixtureShell(): string {
	if (process.platform !== "win32") return "/bin/sh";
	// Do not pick up Windows' WSL sh/bash launcher. CI provides Git for Windows.
	const gitPaths = spawnSync("where.exe", ["git.exe"], { encoding: "utf8" }).stdout?.trim().split(/\r?\n/) ?? [];
	const candidates = [
		...gitPaths.filter(Boolean).map((git) => path.resolve(path.dirname(git), "../bin/bash.exe")),
		...[process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
			.filter((root): root is string => Boolean(root))
			.map((root) => join(root, "Git", "bin", "bash.exe")),
	];
	const shell = candidates.find((candidate) => existsSync(candidate));
	assert.ok(shell, "Gondolin shell fixture requires an installed Git Bash on Windows");
	return shell;
}

const shell = fixtureShell();

function gondolinFixture() {
	const local = (guestPath: string) => guestToHost(guestPath, guest.dir);
	return {
		RealFSProvider: class {
			async open(path: string, flags: string) {
				const target = join(guest.dir, path);
				// RealFSProvider resolves an existing link before open, including dangling links.
				if ((await lstat(target).catch(() => undefined))?.isSymbolicLink()) await realpath(target);
				return open(target, flags);
			}
			lstat(path: string) {
				return lstat(join(guest.dir, path));
			}
		},
		VM: {
			create: async () => ({
				id: "fixture-vm",
				close: async () => {},
				fs: {
					access: (path: string) => access(local(path)),
					mkdir: (path: string, options: { recursive: boolean }) => mkdir(local(path), options),
					readFile: async (path: string, options?: { encoding?: "utf8" }) => {
						try {
							return await readFile(local(path), options?.encoding);
						} catch (error) {
							// Gondolin 0.12.0's VmFsController discards code and keeps this message.
							throw new Error(`failed to read guest file '${path}': ${(error as Error).message}`);
						}
					},
					// Its writeFile has no flag option and always truncates.
					writeFile: (path: string, content: string) => writeFile(local(path), content),
				},
				exec: async (args: string[], options?: { stdin?: string | Buffer }) => {
					assert.equal(args[0], "/bin/sh");
					assert.ok(args[1] === "-c" || args[1] === "-lc");
					// Keep the options, script, and $0 verbatim; only $1... are guest paths.
					// Git Bash accepts drive-qualified forward-slash paths, unlike WSL sh.
					const operands = args.slice(4).map((operand) => local(operand).split(path.sep).join("/"));
					const result = spawnSync(shell, [...args.slice(1, 4), ...operands], {
						cwd: guest.dir,
						input: options?.stdin,
						encoding: "utf8",
					});
					if (result.error) throw result.error;
					if (result.status === 44 && guest.race) {
						guest.race = false;
						if (guest.dangling) await symlink("missing-referent", local(args[4]));
						else await writeFile(local(args[4]), "external winner\n");
					}
					return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
				},
			}),
		},
	};
}

// Execute the full example against transport fixtures, without adding missing SDK APIs.
// The separate tsconfig.remote-examples.json checks the real Gondolin dependency types.
const source = await readFile(new URL("../examples/extensions/gondolin/index.ts", import.meta.url), "utf8");
const compiled = stripTypeScriptTypes(source)
	.replace('import path from "node:path";', "const path = deps.path;")
	.replace(/import \{([\s\S]*?)\} from "@bastani\/atomic";/, "const {$1} = deps.atomic;")
	.replace(/import \{([\s\S]*?)\} from "@earendil-works\/gondolin";/, "const {$1} = deps.gondolin;")
	.replace("export default function", "return function");
const gondolinExtension: (api: ExtensionAPI) => void = new Function("deps", compiled)({
	path: path.posix,
	gondolin: gondolinFixture(),
	atomic: {
		...atomic,
		createCodingTools: (cwd: string, options: atomic.ToolsOptions) =>
			atomic.createCodingTools(cwd, {
				...options,
				read: { ...options.read, operations: guestOperations(options.read!.operations!) },
				write: { ...options.write, operations: guestOperations(options.write!.operations!) },
				edit: { ...options.edit, operations: guestOperations(options.edit!.operations!) },
			}),
	},
});

async function session() {
	const tools = new Map<string, ToolDefinition>();
	let start: (() => Promise<void>) | undefined;
	const ctx = {
		ui: { setStatus() {}, notify() {}, theme: { fg: (_color: string, text: string) => text } },
	} as unknown as ExtensionContext;
	gondolinExtension({
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand() {},
		on(name: string, handler: (event: object, ctx: ExtensionContext) => Promise<void>) {
			if (name === "session_start") start = () => handler({ type: "session_start" }, ctx);
		},
	} as unknown as ExtensionAPI);
	assert.ok(start);
	await start();
	return { tools, ctx, restart: start };
}

describe("Gondolin fixture path boundaries", () => {
	it("maps anchored guest roots to host-native paths under Windows semantics (not Windows execution)", () => {
		const hostDir = "D:\\temp\\workspace\\fixture space";
		for (const root of ["/workspace", "/data/workspace", "/native"]) {
			const destination = root === "/native" ? path.win32.join(hostDir, "native") : hostDir;
			assert.equal(guestToHost(root, hostDir, path.win32), destination);
			assert.equal(
				guestToHost(`${root}/nested/workspace/native/file.txt`, hostDir, path.win32),
				path.win32.join(destination, "nested/workspace/native/file.txt"),
			);
		}
	});

	it("projects SDK-resolved Windows paths into guest roots before adapter routing (semantics only)", () => {
		for (const root of ["/workspace", "/data/workspace", "/native"]) {
			const resolved = path.win32.resolve("C:\\checkout", `${root}/nested/file.txt`);
			const guestPath = toolPathToGuest(resolved, path.win32);
			assert.equal(guestPath, `${root}/nested/file.txt`);
			assert.equal(
				guestToHost(guestPath, "D:\\temp\\fixture", path.win32),
				path.win32.join("D:\\temp\\fixture", root === "/native" ? "native" : "", "nested/file.txt"),
			);
		}
	});

	it("rejects lookalike, embedded, drive-prefixed, and escaping guest roots", () => {
		for (const guestPath of [
			"/workspace-other/file.txt",
			"/other/workspace/file.txt",
			"/C:/workspace/file.txt",
			"/workspace/../outside.txt",
		]) {
			assert.throws(() => guestToHost(guestPath, "/tmp/fixture", path.posix));
			assert.throws(() => guestToHost(guestPath, "D:\\temp\\fixture", path.win32));
		}
		assert.equal(
			guestToHost("/data/workspace/nested/native/file.txt", "/tmp/workspace/fixture", path.posix),
			"/tmp/workspace/fixture/nested/native/file.txt",
		);
	});
});

describe("Gondolin write target observations", () => {
	beforeEach(async () => {
		guest.dir = await mkdtemp(join(tmpdir(), "atomic-gondolin-write-"));
		guest.race = false;
		guest.dangling = false;
	});
	afterEach(async () => {
		await rm(guest.dir, { recursive: true, force: true });
	});

	it("registers only the supported VM-routed tools without a removed grep shim", async () => {
		// #2482: a made-up factory in the fixture hid the example's public API failure.
		const { tools } = await session();
		assert.deepEqual([...tools.keys()].sort(), ["bash", "edit", "find", "ls", "read", "write"]);
	});

	it("retains a guest read observation for a later overwrite", async () => {
		// #2482: registered callbacks must share the session's observation store.
		const { tools, ctx } = await session();
		await writeFile(join(guest.dir, "observed.txt"), "guest bytes\n");
		await tools.get("read")!.execute("read", { path: "observed.txt" }, undefined, undefined, ctx);
		await tools
			.get("write")!
			.execute("write", { path: "observed.txt", content: "replacement\n" }, undefined, undefined, ctx);
		assert.equal(await readFile(join(guest.dir, "observed.txt"), "utf8"), "replacement\n");
	});

	it("creates a missing guest file despite the controller's plain error shape", async () => {
		// #2482: VmFsController does not retain ENOENT.code.
		const { tools, ctx } = await session();
		await tools
			.get("write")!
			.execute("create", { path: "new/file.txt", content: "created\n" }, undefined, undefined, ctx);
		assert.equal(await readFile(join(guest.dir, "new/file.txt"), "utf8"), "created\n");
	});

	it.each(["/workspace", "/data/workspace", "/native"])("retains a concurrent creator under %s", async (root) => {
		// #2482: VmFsWriteFileOptions has no flag and ignores an attempted wx request.
		const { tools, ctx } = await session();
		guest.race = true;
		await assert.rejects(
			tools
				.get("write")!
				.execute("race", { path: `${root}/raced.txt`, content: "loser\n" }, undefined, undefined, ctx),
			(error: Error) => error instanceof FileMutationConflict && error.reason === "target_exists",
		);
		assert.equal(
			await readFile(join(guest.dir, root === "/native" ? "native/raced.txt" : "raced.txt"), "utf8"),
			"external winner\n",
		);
	});

	it("reports a concurrent dangling symlink as a typed collision without changing it", async () => {
		// #2482: the mounted provider throws ENOENT while resolving this occupied path.
		const { tools, ctx } = await session();
		guest.race = true;
		guest.dangling = true;
		await assert.rejects(
			tools.get("write")!.execute("race", { path: "raced.txt", content: "loser\n" }, undefined, undefined, ctx),
			(error: Error) => error instanceof FileMutationConflict && error.reason === "target_exists",
		);
		assert.equal(await readlink(join(guest.dir, "raced.txt")), "missing-referent");
		await assert.rejects(lstat(join(guest.dir, "missing-referent")), { code: "ENOENT" });
	});

	it.each(["", "line\n$() `quoted` 雪\n"])("creates verbatim native guest content: %j", async (content) => {
		const { tools, ctx } = await session();
		await tools.get("write")!.execute("native", { path: "/native/new.txt", content }, undefined, undefined, ctx);
		assert.equal(await readFile(join(guest.dir, "native/new.txt"), "utf8"), content);
	});

	it("retains its own writes but isolates a new session", async () => {
		const { tools, ctx, restart } = await session();
		const write = tools.get("write")!;
		await write.execute("create", { path: "own.txt", content: "first\n" }, undefined, undefined, ctx);
		await write.execute("replace", { path: "own.txt", content: "second\n" }, undefined, undefined, ctx);
		await restart();
		await assert.rejects(
			write.execute("new-session", { path: "own.txt", content: "forbidden\n" }, undefined, undefined, ctx),
			(error: Error) => error instanceof FileMutationConflict && error.reason === "no_prior_observation",
		);
		assert.equal(await readFile(join(guest.dir, "own.txt"), "utf8"), "second\n");
	});

	it("still rejects an externally changed guest target", async () => {
		const { tools, ctx } = await session();
		await writeFile(join(guest.dir, "stale.txt"), "observed\n");
		await tools.get("read")!.execute("read", { path: "stale.txt" }, undefined, undefined, ctx);
		await writeFile(join(guest.dir, "stale.txt"), "external winner\n");
		await assert.rejects(
			tools.get("write")!.execute("stale", { path: "stale.txt", content: "loser\n" }, undefined, undefined, ctx),
			(error: Error) => error instanceof FileMutationConflict && error.reason === "changed_since_observation",
		);
		assert.equal(await readFile(join(guest.dir, "stale.txt"), "utf8"), "external winner\n");
	});

	it("shares read and edit snapshots with a later guest write", async () => {
		const { tools, ctx } = await session();
		await writeFile(join(guest.dir, "edited.txt"), "original\n");
		const result = await tools.get("read")!.execute("read", { path: "edited.txt" }, undefined, undefined, ctx);
		const tag = JSON.stringify(result.content).match(/#([A-F0-9]{4})/)?.[1];
		assert.ok(tag);
		await tools
			.get("edit")!
			.execute("edit", { input: `[edited.txt#${tag}]\nreplace 1:\n+edited` }, undefined, undefined, ctx);
		await tools.get("write")!.execute("write", { path: "edited.txt", content: "final\n" }, undefined, undefined, ctx);
		assert.equal(await readFile(join(guest.dir, "edited.txt"), "utf8"), "final\n");
	});

	it("does not classify an unreadable guest directory as missing", async () => {
		const { tools, ctx } = await session();
		await mkdir(join(guest.dir, "directory"));
		await assert.rejects(
			tools
				.get("write")!
				.execute("directory", { path: "directory", content: "forbidden" }, undefined, undefined, ctx),
			(error: Error) => error instanceof FileMutationConflict && error.reason === "target_unreadable",
		);
	});

	it("executes shell scripts verbatim and translates only positional path operands", async () => {
		const vm = await gondolinFixture().VM.create();
		const result = await vm.exec([
			"/bin/sh",
			"-c",
			'printf "/workspace literal\\n"; printf "%s" "$2" > "$1"',
			"sh",
			"/workspace/shell output.txt",
			"/native",
		]);
		assert.equal(result.exitCode, 0, result.stderr);
		assert.equal(result.stdout, "/workspace literal\n");
		assert.equal(
			await readFile(join(guest.dir, "shell output.txt"), "utf8"),
			join(guest.dir, "native").replaceAll("\\", "/"),
		);
	});
});
