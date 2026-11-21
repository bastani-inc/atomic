import assert from "node:assert/strict";
import { type ExecFileException, execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	findHelperExecutable,
	findHelperExecutableAsync,
	helperLaunch,
	missingHelperOptions,
} from "../../packages/tui/src/executable-path.ts";

const windows = process.platform === "win32";

let root: string;
let cwd: string;

/** An empty file named `name` in `directory`, executable where that matters. */
function program(directory: string, name: string): string {
	mkdirSync(directory, { recursive: true });
	const file = join(directory, name);
	writeFileSync(file, windows ? "" : "#!/bin/sh\nexit 0\n");
	if (!windows) chmodSync(file, 0o755);
	return file;
}

const exe = (name: string) => (windows ? `${name}.exe` : name);

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "atomic-helper-path-"));
	cwd = join(root, "project");
	mkdirSync(cwd);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("findHelperExecutable", () => {
	test("finds a program in the first absolute PATH directory that holds it, by its absolute path", async () => {
		const first = join(root, "first");
		const second = join(root, "second");
		program(second, exe("tool"));
		const expected = program(first, exe("tool"));
		const env = { PATH: [join(root, "none"), first, second].join(delimiter) };

		assert.equal(findHelperExecutable("tool", { env, cwd }), expected);
		assert.equal(await findHelperExecutableAsync("tool", { env, cwd }), expected);
	});

	test("never finds a program in the working directory, through an empty, relative or absolute PATH entry", async () => {
		program(cwd, exe("tool"));
		mkdirSync(join(cwd, "bin"));
		program(join(cwd, "bin"), exe("tool"));
		for (const path of ["", delimiter, ".", "bin", cwd, `.${delimiter}bin${delimiter}${cwd}`]) {
			assert.equal(findHelperExecutable("tool", { env: { PATH: path }, cwd }), undefined, `PATH=${path}`);
			assert.equal(await findHelperExecutableAsync("tool", { env: { PATH: path }, cwd }), undefined, `PATH=${path}`);
		}
	});

	test("never finds a program in this process's working directory either", () => {
		const own = join(root, "own");
		program(own, exe("tool"));
		const previous = process.cwd();
		process.chdir(own);
		try {
			assert.equal(findHelperExecutable("tool", { env: { PATH: own }, cwd }), undefined);
		} finally {
			process.chdir(previous);
		}
	});

	test("leaves a name that is already a path as it is", () => {
		const path = join(root, "x", exe("tool"));
		assert.equal(findHelperExecutable(path, { env: { PATH: "" }, cwd }), path);
		assert.equal(findHelperExecutable("./tool", { env: { PATH: "" }, cwd }), "./tool");
	});

	test("skips a directory with the program's name and a file that is not a program", () => {
		const bin = join(root, "bin");
		mkdirSync(join(bin, exe("tool")), { recursive: true });
		const later = program(join(root, "later"), exe("tool"));
		const env = { PATH: [bin, join(root, "later")].join(delimiter) };
		assert.equal(findHelperExecutable("tool", { env, cwd }), later);
	});

	test.skipIf(windows)("skips a file without execute permission, as execvp does", () => {
		const bin = join(root, "bin");
		program(bin, "tool");
		chmodSync(join(bin, "tool"), 0o644);
		const later = program(join(root, "later"), "tool");
		assert.equal(
			findHelperExecutable("tool", { env: { PATH: [bin, join(root, "later")].join(delimiter) }, cwd }),
			later,
		);
	});
});

describe.skipIf(!windows)("findHelperExecutable on Windows", () => {
	test("tries the extensions Windows starts directly, in PATHEXT's order, and .cmd only for a shell", () => {
		const bin = join(root, "bin");
		program(bin, "tool.cmd");
		const env = { Path: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
		assert.equal(findHelperExecutable("tool", { env, cwd }), undefined);
		assert.equal(findHelperExecutable("tool", { env, cwd, shellScripts: true }), join(bin, "tool.cmd"));
		const exeFile = program(bin, "tool.exe");
		assert.equal(findHelperExecutable("tool", { env, cwd, shellScripts: true }), exeFile);
		const comFile = program(bin, "tool.com");
		assert.equal(findHelperExecutable("tool", { env, cwd }), comFile);
	});

	test("tries a name with an extension as it is first, and reads PATH whatever its case", () => {
		const bin = join(root, "bin");
		const asIs = program(bin, "tool.exe");
		program(bin, "tool.exe.exe");
		assert.equal(findHelperExecutable("tool.exe", { env: { pAtH: bin }, cwd }), asIs);
	});

	test("never finds a program in the working directory under another letter case or in quotes", () => {
		program(cwd, "tool.exe");
		for (const path of [cwd.toUpperCase(), `"${cwd}"`, `${cwd}\\`]) {
			assert.equal(findHelperExecutable("tool", { env: { PATH: path }, cwd }), undefined, `PATH=${path}`);
		}
	});
});

describe("helperLaunch", () => {
	test("starting a helper that was not found fails as starting a program that is not installed does", async () => {
		program(cwd, exe("atomic-missing-helper"));
		const env = { ...process.env, PATH: `${delimiter}${cwd}` };
		const launch = helperLaunch("atomic-missing-helper", { env, cwd });
		assert.equal(launch.file, "atomic-missing-helper");
		const error = await new Promise<ExecFileException | null>((resolve) =>
			execFile(launch.file, ["--version"], { env, cwd, ...missingHelperOptions(launch) }, (failure) =>
				resolve(failure),
			),
		);
		assert.equal(error?.code, "ENOENT");
		assert.equal(error?.message, "spawn atomic-missing-helper ENOENT");
	});

	test("a helper that was found starts with the caller's options", () => {
		const bin = join(root, "bin");
		const file = program(bin, exe("tool"));
		const launch = helperLaunch("tool", { env: { PATH: bin }, cwd });
		assert.deepEqual(launch, { file });
		assert.deepEqual(missingHelperOptions(launch), {});
	});
});
