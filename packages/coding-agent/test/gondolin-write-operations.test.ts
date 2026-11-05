import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/index.ts";
import * as atomic from "../src/index.ts";

const guest = { dir: "" };

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
		RealFSProvider: class {},
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
					// A script may exit without reading stdin (noclobber fails before cat runs); a VM
					// exec reports the exit status, so only a missing status is a transport failure.
					const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
					const unreadStdin = errorCode === "EPIPE" || errorCode === "EOF";
					if (result.error && !(unreadStdin && result.status !== null)) throw result.error;
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

describe("Gondolin file tools", () => {
	beforeEach(async () => {
		guest.dir = await mkdtemp(join(tmpdir(), "atomic-gondolin-write-"));
	});
	afterEach(async () => {
		await rm(guest.dir, { recursive: true, force: true });
	});

	it("registers only the supported VM-routed tools without a removed grep shim", async () => {
		// #2482: a made-up factory in the fixture hid the example's public API failure.
		const { tools } = await session();
		assert.deepEqual([...tools.keys()].sort(), ["bash", "edit", "find", "ls", "read", "write"]);
	});

	it("overwrites a guest file without reading it first (#4328)", async () => {
		const { tools, ctx } = await session();
		await writeFile(join(guest.dir, "existing.txt"), "guest bytes\n");
		await tools
			.get("write")!
			.execute("write", { path: "existing.txt", content: "replacement\n" }, undefined, undefined, ctx);
		assert.equal(await readFile(join(guest.dir, "existing.txt"), "utf8"), "replacement\n");
	});

	it("creates a missing guest file in new parents", async () => {
		const { tools, ctx } = await session();
		await tools
			.get("write")!
			.execute("create", { path: "new/file.txt", content: "created\n" }, undefined, undefined, ctx);
		assert.equal(await readFile(join(guest.dir, "new/file.txt"), "utf8"), "created\n");
	});

	it.each(["", "line\n$() `quoted` 雪\n"])("creates verbatim native guest content: %j", async (content) => {
		const { tools, ctx } = await session();
		await tools.get("write")!.execute("native", { path: "/native/new.txt", content }, undefined, undefined, ctx);
		assert.equal(await readFile(join(guest.dir, "native/new.txt"), "utf8"), content);
	});

	it("edits a guest file by exact text after it changed in the guest (#4328)", async () => {
		const { tools, ctx } = await session();
		await writeFile(join(guest.dir, "edited.txt"), "original\n");
		await tools.get("read")!.execute("read", { path: "edited.txt" }, undefined, undefined, ctx);
		await writeFile(join(guest.dir, "edited.txt"), "changed in guest\n");
		await tools
			.get("edit")!
			.execute(
				"edit",
				{ path: "edited.txt", edits: [{ oldText: "changed in guest", newText: "edited" }] },
				undefined,
				undefined,
				ctx,
			);
		assert.equal(await readFile(join(guest.dir, "edited.txt"), "utf8"), "edited\n");
	});

	it("does not replace a guest directory with a file", async () => {
		const { tools, ctx } = await session();
		await mkdir(join(guest.dir, "directory"));
		await assert.rejects(
			tools
				.get("write")!
				.execute("directory", { path: "directory", content: "forbidden" }, undefined, undefined, ctx),
			{ code: "EISDIR" },
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

	it("reports the exit status of a script that exits without reading its stdin", async () => {
		const vm = await gondolinFixture().VM.create();
		const result = await vm.exec(["/bin/sh", "-c", "exit 17", "sh"], { stdin: "x".repeat(1 << 20) });
		assert.equal(result.exitCode, 17);
	});
});
