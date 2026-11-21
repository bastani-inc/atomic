import assert from "node:assert/strict";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

const windows = process.platform === "win32";

/** Where Linux and macOS keep bash: hidden by the first test, which looks for a shell where no bash is installed there. */
const hiddenPaths = vi.hoisted(() => new Set<string>());
/** Folders whose real path is read without an answer, as on a network share that stopped responding. */
const heldRealpaths = vi.hoisted(() => new Set<string>());
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const accessSync: typeof actual.accessSync = (path, mode) => {
		if (hiddenPaths.has(String(path))) throw Object.assign(new Error(`ENOENT: ${String(path)}`), { code: "ENOENT" });
		return actual.accessSync(path, mode);
	};
	return { ...actual, accessSync, default: { ...actual, accessSync } };
});
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const access: typeof actual.access = (path, mode) =>
		hiddenPaths.has(String(path))
			? Promise.reject(Object.assign(new Error(`ENOENT: ${String(path)}`), { code: "ENOENT" }))
			: actual.access(path, mode);
	const realpath = ((path: string, options?: BufferEncoding) =>
		heldRealpaths.has(String(path))
			? new Promise(() => {})
			: actual.realpath(path, options)) as typeof actual.realpath;
	return { ...actual, access, realpath, default: { ...actual, access, realpath } };
});

/**
 * A program named `name` in `directory` that records each run in `marker`: elsewhere a shell script; on Windows a copy of
 * this Node, which a run shows by its successful start.
 */
function plantProgram(directory: string, name: string): string {
	if (windows) {
		const file = join(directory, `${name}.exe`);
		try {
			linkSync(process.execPath, file);
		} catch {
			copyFileSync(process.execPath, file);
		}
		return file;
	}
	const file = join(directory, name);
	writeFileSync(file, '#!/bin/sh\necho "$0" >> "$PLANTED_PROGRAM_MARKER"\nsleep 5\n');
	chmodSync(file, 0o755);
	return file;
}

/** How long a started server may take to record its run on a loaded machine. */
const SERVER_START_BUDGET_MS = 20_000;

let root: string;
let project: string;
let marker: string;
let previousCwd: string;

function runs(): string[] {
	return existsSync(marker) ? readFileSync(marker, "utf8").split(/\r?\n/).filter(Boolean) : [];
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "atomic-planted-shell-"));
	project = join(root, "project");
	const emptyBin = join(root, "empty-bin");
	mkdirSync(project);
	mkdirSync(emptyBin);
	marker = join(root, "runs.txt");
	vi.stubEnv("PLANTED_PROGRAM_MARKER", marker);
	// Windows looks in the working directory before PATH; elsewhere an empty PATH entry names it.
	vi.stubEnv("PATH", windows ? emptyBin : `${delimiter}${emptyBin}`);
	previousCwd = process.cwd();
	process.chdir(project);
	vi.resetModules();
});

afterEach(() => {
	process.chdir(previousCwd);
	hiddenPaths.clear();
	heldRealpaths.clear();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("shells and MCP servers Atomic starts by name come only from PATH, never from the project folder", () => {
	test.skipIf(windows)("without bash in /bin the bash tool's shell is never a sh in the project folder", async () => {
		hiddenPaths.add("/bin/bash");
		plantProgram(project, "sh");
		plantProgram(project, "bash");
		const { getShellConfig, getShellConfigAsync } = await import("../src/utils/shell.ts");

		for (const config of [getShellConfig(), await getShellConfigAsync()]) {
			assert.ok(isAbsolute(config.shell), config.shell);
			assert.ok(!config.shell.startsWith(project), config.shell);
		}
	});

	test.skipIf(windows)(
		"a shell found before is not taken again once the folder its commands run in is the shell's directory",
		async () => {
			hiddenPaths.add("/bin/bash");
			const tools = join(root, "tools");
			const elsewhere = join(root, "elsewhere");
			mkdirSync(tools);
			mkdirSync(elsewhere);
			const bash = plantProgram(tools, "bash");
			// The folder commands run in, under one name that comes to mean the shell's directory.
			const folder = join(root, "folder");
			symlinkSync(elsewhere, folder);
			vi.stubEnv("PATH", tools);
			const { getShellConfig, getShellConfigAsync } = await import("../src/utils/shell.ts");
			assert.equal(getShellConfig(undefined, folder).shell, bash);
			assert.equal((await getShellConfigAsync(undefined, folder)).shell, bash);

			rmSync(folder);
			symlinkSync(tools, folder);

			assert.equal(getShellConfig(undefined, folder).shell, "/bin/sh");
			assert.equal((await getShellConfigAsync(undefined, folder)).shell, "/bin/sh");
		},
	);

	test.skipIf(!windows)(
		"the bash and PowerShell tools never take a bash or PowerShell from the project folder",
		async () => {
			vi.stubEnv("ProgramFiles", join(root, "no-program-files"));
			vi.stubEnv("ProgramFiles(x86)", join(root, "no-program-files"));
			for (const name of ["bash", "pwsh", "powershell"]) plantProgram(project, name);
			const { getPowerShellConfig, getPowerShellConfigAsync, getShellConfig, getShellConfigAsync } = await import(
				"../src/utils/shell.ts"
			);

			assert.throws(() => getShellConfig(), /No bash shell found/);
			await assert.rejects(getShellConfigAsync(), /No bash shell found/);
			for (const config of [getPowerShellConfig(), await getPowerShellConfigAsync()]) {
				assert.ok(!config.shell.toLowerCase().startsWith(project.toLowerCase()), config.shell);
			}
		},
	);

	test("an MCP server named by its program is never started from the project folder", async () => {
		plantProgram(project, "atomic-test-mcp-server");
		const { StdioTransport } = await import("../src/extensions/mcp/client/transports/stdio.ts");
		const transport = new StdioTransport({ command: "atomic-test-mcp-server", cwd: project, projectCwd: project });

		await assert.rejects(transport.start(), { code: "ENOENT" });
		await transport.close();
		assert.deepEqual(runs(), []);
	});

	test("the same MCP server program in a PATH directory starts", async () => {
		const bin = join(root, "bin");
		mkdirSync(bin);
		plantProgram(bin, "atomic-test-mcp-server");
		vi.stubEnv("PATH", windows ? bin : `${delimiter}${bin}`);
		const { StdioTransport } = await import("../src/extensions/mcp/client/transports/stdio.ts");
		const transport = new StdioTransport({
			command: "atomic-test-mcp-server",
			args: windows ? ["-e", "setTimeout(() => {}, 5000)"] : [],
			cwd: project,
			projectCwd: project,
		});

		await transport.start();
		assert.ok(transport.pid !== undefined);
		await transport.close();
	});

	test.skipIf(!windows)(
		"an MCP server's configured PATH chooses its program and is the PATH it gets, however either PATH is spelled",
		async () => {
			const inherited = join(root, "inherited");
			const configured = join(root, "configured");
			mkdirSync(inherited);
			mkdirSync(configured);
			plantProgram(inherited, "atomic-test-mcp-server");
			const expected = plantProgram(configured, "atomic-test-mcp-server");
			vi.stubEnv("PATH", inherited);
			const { StdioTransport } = await import("../src/extensions/mcp/client/transports/stdio.ts");
			const transport = new StdioTransport({
				command: "atomic-test-mcp-server",
				args: [
					"-e",
					'const { appendFileSync } = require("fs"); const { env, execPath } = process; appendFileSync(env.PLANTED_PROGRAM_MARKER, execPath + "\\n" + env.PATH + "\\n"); setTimeout(() => {}, 5000)',
				],
				cwd: project,
				projectCwd: project,
				// Sorted after the inherited `Path`, so without replacing it the program would get the inherited one.
				env: { path: configured },
			});

			await transport.start();
			await vi.waitFor(() => assert.equal(runs().length, 2), { timeout: SERVER_START_BUDGET_MS });
			await transport.close();
			assert.deepEqual(runs(), [expected, configured]);
		},
	);

	test.skipIf(!windows)(
		"an MCP server whose folder is a link into the project folder never starts a program from there",
		async () => {
			const inside = join(project, "server");
			mkdirSync(inside);
			plantProgram(inside, "atomic-test-mcp-server");
			// Outside the project folder by its name, inside it by what it is.
			const link = join(root, "server-link");
			symlinkSync(inside, link, "junction");
			const { StdioTransport } = await import("../src/extensions/mcp/client/transports/stdio.ts");
			const transport = new StdioTransport({ command: "atomic-test-mcp-server", cwd: link, projectCwd: project });

			await assert.rejects(transport.start(), { code: "ENOENT" });
			await transport.close();
		},
	);

	test("an MCP server closed while its folder is compared with the project folder never starts", async () => {
		const elsewhere = join(root, "elsewhere");
		mkdirSync(elsewhere);
		heldRealpaths.add(elsewhere);
		const { StdioTransport } = await import("../src/extensions/mcp/client/transports/stdio.ts");
		const { McpConnectionClosedError } = await import("../src/extensions/mcp/client/protocol/jsonrpc.ts");
		const transport = new StdioTransport({ command: "atomic-test-mcp-server", cwd: elsewhere, projectCwd: project });
		// The comparison is made where Windows would look in the server's folder first.
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		let started: Promise<void>;
		try {
			started = transport.start();
		} finally {
			Object.defineProperty(process, "platform", platform);
		}

		await transport.close();
		await assert.rejects(started, McpConnectionClosedError);
		assert.equal(transport.pid, undefined);
	});

	test("an MCP server closed while its program is looked up never starts", async () => {
		const bin = join(root, "bin");
		mkdirSync(bin);
		plantProgram(bin, "atomic-test-mcp-server");
		vi.stubEnv("PATH", windows ? bin : `${delimiter}${bin}`);
		const { StdioTransport } = await import("../src/extensions/mcp/client/transports/stdio.ts");
		const transport = new StdioTransport({ command: "atomic-test-mcp-server", cwd: project, projectCwd: project });

		const started = transport.start();
		await transport.close();
		await assert.rejects(started);
		assert.equal(transport.pid, undefined);
		assert.deepEqual(runs(), []);
	});
});
