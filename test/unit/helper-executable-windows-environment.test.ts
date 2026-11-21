import assert from "node:assert/strict";
import type * as Fs from "node:fs";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, test, vi } from "vitest";
import { findHelperExecutable, findHelperExecutableAsync } from "../../packages/tui/src/executable-path.ts";

// Windows' rules on any machine: the programs and app execution aliases below exist only for these stand-ins.
const { files } = vi.hoisted(() => ({
	files: { programs: new Set<string>(), aliases: new Set<string>(), regular: "", danglingLink: "" },
}));

function standIn(path: Fs.PathLike): "program" | "alias" | undefined {
	const name = String(path);
	return files.programs.has(name) ? "program" : files.aliases.has(name) ? "alias" : undefined;
}

const denied = (path: Fs.PathLike) =>
	Object.assign(new Error(`EACCES: permission denied, stat '${String(path)}'`), { code: "EACCES" });

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	const accessSync = ((path: Fs.PathLike, mode?: number) => {
		if (standIn(path) === undefined) actual.accessSync(path, mode);
	}) as typeof actual.accessSync;
	const lstatSync = ((path: Fs.PathLike, options?: Fs.StatSyncOptions) => {
		const kind = standIn(path);
		if (kind === "program") return actual.lstatSync(files.regular);
		if (kind === "alias") return actual.lstatSync(files.danglingLink);
		return actual.lstatSync(path, options);
	}) as typeof actual.lstatSync;
	const statSync = ((path: Fs.PathLike, options?: Fs.StatSyncOptions) => {
		const kind = standIn(path);
		if (kind === "program") return actual.statSync(files.regular);
		// An app execution alias is a link Windows cannot follow for a file read.
		if (kind === "alias") throw denied(path);
		return actual.statSync(path, options);
	}) as typeof actual.statSync;
	return { ...actual, accessSync, lstatSync, statSync };
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FsPromises>();
	const access = ((path: Fs.PathLike, mode?: number) =>
		standIn(path) === undefined ? actual.access(path, mode) : Promise.resolve()) as typeof actual.access;
	const lstat = ((path: Fs.PathLike, options?: Fs.StatOptions) => {
		const kind = standIn(path);
		if (kind === "program") return actual.lstat(files.regular);
		if (kind === "alias") return actual.lstat(files.danglingLink);
		return actual.lstat(path, options);
	}) as typeof actual.lstat;
	const stat = ((path: Fs.PathLike, options?: Fs.StatOptions) => {
		const kind = standIn(path);
		if (kind === "program") return actual.stat(files.regular);
		if (kind === "alias") return Promise.reject(denied(path));
		return actual.stat(path, options);
	}) as typeof actual.stat;
	return { ...actual, access, lstat, stat };
});

const root = mkdtempSync(join(tmpdir(), "atomic-helper-windows-"));
files.regular = join(root, "regular");
writeFileSync(files.regular, "");
files.danglingLink = join(root, "dangling");
symlinkSync(join(root, "missing"), files.danglingLink, process.platform === "win32" ? "junction" : undefined);

const BIN = "Q:\\atomic-test\\bin";
const STALE = "Q:\\atomic-test\\stale";
const ALIASES = "Q:\\atomic-test\\WindowsApps";
const options = { platform: "win32" } as const;

afterEach(() => {
	files.programs.clear();
	files.aliases.clear();
	vi.unstubAllEnvs();
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("helper programs by Windows' rules", () => {
	test("reads the PATH Node gives the program when the environment spells PATH twice", async () => {
		files.programs.add(`${BIN}\\tool.exe`);
		files.programs.add(`${STALE}\\other.exe`);
		// As `{ ...process.env, PATH: ... }` builds it in a console, whose variable is spelled Path.
		const env = { Path: STALE, PATH: BIN };

		assert.equal(findHelperExecutable("tool", { ...options, env }), `${BIN}\\tool.exe`);
		assert.equal(await findHelperExecutableAsync("tool", { ...options, env }), `${BIN}\\tool.exe`);
		assert.equal(findHelperExecutable("other", { ...options, env }), undefined);
	});

	test("searches this process's PATH for an environment without one, as the started program gets it", async () => {
		files.programs.add(`${BIN}\\tool.exe`);
		vi.stubEnv("PATH", BIN);
		const env = { SystemRoot: "C:\\Windows" };

		assert.equal(findHelperExecutable("tool", { ...options, env }), `${BIN}\\tool.exe`);
		assert.equal(await findHelperExecutableAsync("tool", { ...options, env }), `${BIN}\\tool.exe`);
		assert.equal(findHelperExecutable("tool", { ...options, env: { PATH: "" } }), undefined);
	});

	test("reads a PATH entry whose last segment ends in a period as Windows does, without it", async () => {
		files.programs.add(`${BIN}\\tool.exe`);
		const env = { PATH: `${BIN}.` };

		assert.equal(findHelperExecutable("tool", { ...options, env }), `${BIN}\\tool.exe`);
		assert.equal(await findHelperExecutableAsync("tool", { ...options, env }), `${BIN}\\tool.exe`);
	});

	test("tries .com and .exe after PATHEXT's extensions when PATHEXT names neither, as a start without a shell does", () => {
		files.programs.add(`${BIN}\\tool.exe`);
		files.programs.add(`${BIN}\\script.cmd`);
		const env = { PATH: BIN, PATHEXT: ".BAT;.CMD" };

		assert.equal(findHelperExecutable("tool", { ...options, env }), `${BIN}\\tool.exe`);
		assert.equal(findHelperExecutable("script", { ...options, env }), undefined);
		assert.equal(findHelperExecutable("script", { ...options, env, shellScripts: true }), `${BIN}\\script.cmd`);
	});

	test("tries .com and .exe in PATHEXT's order, as cmd.exe does", () => {
		files.programs.add(`${BIN}\\tool.com`);
		files.programs.add(`${BIN}\\tool.exe`);

		assert.equal(
			findHelperExecutable("tool", { ...options, env: { PATH: BIN, PATHEXT: ".EXE;.COM" } }),
			`${BIN}\\tool.exe`,
		);
		assert.equal(findHelperExecutable("tool", { ...options, env: { PATH: BIN } }), `${BIN}\\tool.com`);
	});

	test("finds an app execution alias, which only an existence check can read", async () => {
		files.aliases.add(`${ALIASES}\\winget.exe`);
		const env = { PATH: ALIASES };

		assert.equal(findHelperExecutable("winget", { ...options, env }), `${ALIASES}\\winget.exe`);
		assert.equal(await findHelperExecutableAsync("winget", { ...options, env }), `${ALIASES}\\winget.exe`);
	});
});
