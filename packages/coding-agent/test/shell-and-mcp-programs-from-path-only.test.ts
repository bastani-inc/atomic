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
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

const windows = process.platform === "win32";

/** Where Linux and macOS keep bash: hidden by the first test, which looks for a shell where no bash is installed there. */
const hiddenPaths = vi.hoisted(() => new Set<string>());
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const accessSync: typeof actual.accessSync = (path, mode) => {
		if (hiddenPaths.has(String(path))) throw Object.assign(new Error(`ENOENT: ${String(path)}`), { code: "ENOENT" });
		return actual.accessSync(path, mode);
	};
	return { ...actual, accessSync, default: { ...actual, accessSync } };
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
