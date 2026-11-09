import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, sep, win32 } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	bashPath,
	bashPathOn,
	evaluateEnvrc,
	sessionEnvironmentPrefix,
	sessionEnvrcPath,
	shellQuote,
} from "../src/core/resume/blueprint/envrc.ts";
import * as shell from "../src/utils/shell.ts";

let sandbox: string;

beforeEach(() => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "blueprint-envrc-")));
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(sandbox, { recursive: true, force: true });
});

const path = (...segments: string[]) => join(sandbox, ...segments);

function bash(script: string): string {
	const { shell: executable, args, commandTransport } = shell.getShellConfig();
	const byStdin = commandTransport === "stdin";
	const result = spawnSync(executable, byStdin ? args : [...args, script], {
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "" },
		...(byStdin ? { input: script } : {}),
	});
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

function writeSessionEnvrc(store: string, root: string, content: string): string {
	const file = sessionEnvrcPath(store, root);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
	return file;
}

describe("bash quoting (#4588)", () => {
	test("a value is one single-quoted word and a single quote inside it is closed, escaped and reopened (#4588)", () => {
		assert.equal(shellQuote("plain"), "'plain'");
		assert.equal(shellQuote(""), "''");
		assert.equal(shellQuote("it's"), "'it'\\''s'");
		assert.equal(shellQuote("''"), "''\\'''\\'''");
	});

	test("bash reads a quoted value back unchanged, whatever it contains (#4588)", () => {
		const value = `a b'c"d $HOME \`id\` \\n * ; &\nline two`;
		assert.equal(bash(`printf %s ${shellQuote(value)}`), value);
	});
});

describe("bash paths (#4588)", () => {
	test("on Windows a drive path becomes Git Bash's /<drive>/ form with forward slashes (#4588)", () => {
		assert.equal(bashPathOn("win32", "C:\\Users\\Dev\\.atomic\\x.envrc"), "/c/Users/Dev/.atomic/x.envrc");
		assert.equal(bashPathOn("win32", "D:/data/x"), "/d/data/x");
		assert.equal(bashPathOn("win32", "c:\\a\\..\\b"), "/c/b");
		assert.equal(bashPathOn("win32", "e:\\"), "/e/");
	});

	test("on Windows only a path that starts with a drive and a separator is a drive path (#4588)", () => {
		assert.equal(bashPathOn("win32", "C:foo\\bar"), "C:foo/bar");
		assert.equal(bashPathOn("win32", "1:\\x"), "./1:/x");
		assert.equal(bashPathOn("win32", "sub\\c:\\x"), "./sub/c:/x");
		assert.equal(bashPathOn("win32", "\\\\server\\share\\dir\\f"), "//server/share/dir/f");
		assert.equal(bashPathOn("win32", "rel\\sub\\..\\f"), "rel/f");
	});

	test("outside Windows a path is left exactly as it is (#4588)", () => {
		for (const platform of ["linux", "darwin", "freebsd"] as const) {
			assert.equal(bashPathOn(platform, "C:\\Users\\x"), "C:\\Users\\x");
			assert.equal(bashPathOn(platform, "/tmp/a/../b"), "/tmp/a/../b");
		}
	});

	test("bashPath is the spelling of this platform (#4588)", () => {
		const file = path("x.envrc");
		assert.equal(bashPath(file), bashPathOn(process.platform, file));
	});
});

describe("session environment files (#4588)", () => {
	test("a worktree's file is a 16-character key under blueprint-env in the store, the same for every spelling of the root (#4588)", () => {
		const store = path("store");
		const file = sessionEnvrcPath(store, path("repos", "one"));
		assert.equal(dirname(file), join(store, "blueprint-env"));
		assert.match(basename(file), /^[0-9a-f]{16}\.envrc$/);
		assert.equal(sessionEnvrcPath(store, `${path("repos", "one")}${sep}.`), file);
		assert.equal(sessionEnvrcPath(store, relative(process.cwd(), path("repos", "one"))), file);
		assert.notEqual(sessionEnvrcPath(store, path("repos", "two")), file);
		assert.notEqual(sessionEnvrcPath(path("other-store"), path("repos", "one")), file);
	});

	test("the prefix sources, in order, the files that exist for the roots, each once, with every assignment exported (#4588)", () => {
		const store = path("store");
		const [first, second, third] = [path("repos", "first"), path("repos", "second"), path("repos", "third")];
		const firstFile = writeSessionEnvrc(store, first, "FIRST=1\n");
		const thirdFile = writeSessionEnvrc(store, third, "THIRD=3\n");
		assert.equal(
			sessionEnvironmentPrefix(store, [third, second, first, third]),
			`set -a; . '${bashPath(thirdFile)}'; . '${bashPath(firstFile)}'; set +a`,
		);
		assert.equal(
			sessionEnvironmentPrefix(store, new Set([second, first])),
			`set -a; . '${bashPath(firstFile)}'; set +a`,
		);
		assert.equal(sessionEnvironmentPrefix(store, [second]), undefined);
		assert.equal(sessionEnvironmentPrefix(store, []), undefined);
	});

	test("the prefix gives a command the variables and leaves its own assignments unexported (#4588)", () => {
		const store = path("store");
		const [first, second] = [path("repos", "first"), path("repos", "second")];
		writeSessionEnvrc(store, first, "SHARED=one\nexport PATH_EXTRA='two words'\n");
		writeSessionEnvrc(store, second, "SECOND=2\n");
		const prefix = sessionEnvironmentPrefix(store, [first, second]);
		assert.ok(prefix !== undefined);
		const shown = bash(`${prefix}\nLATE=1\nenv | grep -E '^(SHARED|PATH_EXTRA|SECOND|LATE)=' | sort`);
		assert.equal(shown, "PATH_EXTRA=two words\nSECOND=2\nSHARED=one\n");
	});

	test("a file path with a single quote is quoted so bash still reads it (#4588)", () => {
		const store = path("it's a store");
		const root = path("repos", "quoted");
		writeSessionEnvrc(store, root, "QUOTED=yes\n");
		const prefix = sessionEnvironmentPrefix(store, [root]);
		assert.ok(prefix !== undefined);
		assert.equal(bash(`${prefix}\nenv | grep '^QUOTED='`), "QUOTED=yes\n");
	});
});

describe("evaluating an ENVRC file (#4588)", () => {
	const base = () => ({ PATH: process.env.PATH ?? "", KEEP: "from-base", OVERRIDDEN: "from-base" });

	test("the result is the base environment after bash sources the file with every assignment exported (#4588)", async () => {
		const file = path("build.envrc");
		writeFileSync(
			file,
			[
				"PLAIN=1",
				'export QUOTED="two words"',
				'URL="http://host/?a=b=c"',
				"SUBSTITUTED=$(printf computed)",
				"OVERRIDDEN=from-file",
				"MULTILINE=$'first\\nsecond'",
				"",
			].join("\n"),
		);
		const environment = await evaluateEnvrc(file, base());
		assert.equal(environment.PLAIN, "1");
		assert.equal(environment.QUOTED, "two words");
		assert.equal(environment.URL, "http://host/?a=b=c");
		assert.equal(environment.SUBSTITUTED, "computed");
		assert.equal(environment.OVERRIDDEN, "from-file");
		assert.equal(environment.MULTILINE, "first\nsecond");
		assert.equal(environment.KEEP, "from-base");
		const expectedPath = process.platform === "win32" ? bash('/usr/bin/cygpath -wp "$PATH"').trimEnd() : base().PATH;
		assert.equal(environment.PATH, expectedPath);
		assert.equal("" in environment, false);
		assert.equal(
			Object.values(environment).every((value) => typeof value === "string"),
			true,
		);
	});

	test("a quoted ENVRC path stays data and cannot execute shell syntax (#4588)", async () => {
		const directory = path("it's a $(exit 8) store");
		mkdirSync(directory);
		const file = join(directory, "build.envrc");
		writeFileSync(file, "FROM_QUOTED_PATH=yes\n");
		assert.equal((await evaluateEnvrc(file, base())).FROM_QUOTED_PATH, "yes");
	});

	test("PATH written to ENVRC reaches native processes in their own path-list format (#4588)", async () => {
		const directory = path("custom bin");
		mkdirSync(directory);
		const file = path("path.envrc");
		writeFileSync(file, `export PATH=${shellQuote(bashPath(directory))}:"$PATH"\n`);
		const environment = await evaluateEnvrc(file, base());
		const result = spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(process.env.PATH))"], {
			env: environment,
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
		const directories = (JSON.parse(result.stdout) as string).split(delimiter);
		const normalize = process.platform === "win32" ? win32.normalize : (value: string) => value;
		assert.equal(normalize(directories[0]!), normalize(directory));
	});

	test("a shell that takes its script on stdin still receives the ENVRC as a positional argument (#4588)", async () => {
		const config = shell.getShellConfig();
		vi.spyOn(shell, "getShellConfig").mockReturnValue({
			shell: config.shell,
			args: ["-s"],
			commandTransport: "stdin",
		});
		const file = path("stdin's build.envrc");
		writeFileSync(file, "FROM_STDIN=yes\n");
		assert.equal((await evaluateEnvrc(file, base())).FROM_STDIN, "yes");
	});

	test("Windows evaluation converts the sourced PATH for native children with cygpath (#4588)", async () => {
		const config = shell.getShellConfig();
		vi.spyOn(shell, "getShellConfig").mockReturnValue(config);
		const commands = path("commands");
		mkdirSync(commands);
		const converter = join(commands, "cygpath");
		writeFileSync(
			converter,
			'#!/bin/sh\n[ "$1" = -wp ] || exit 4\nprintf "%s" "$2" > "$CAPTURE_PATH"\nprintf "%s\\n" "$NATIVE_PATH"\n',
		);
		chmodSync(converter, 0o755);
		const file = path("windows.envrc");
		const captured = path("captured-path");
		const extra = path("extra tools");
		writeFileSync(file, `export PATH=${shellQuote(bashPath(extra))}:${shellQuote(bashPath(commands))}:"$PATH"\n`);
		const realPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			const environment = await evaluateEnvrc(file, {
				...base(),
				PATH: `${commands}${delimiter}${base().PATH}`,
				CAPTURE_PATH: captured,
				NATIVE_PATH: "C:\\extra tools;C:\\base",
			});
			assert.equal(environment.PATH, "C:\\extra tools;C:\\base");
			assert.ok(readFileSync(captured, "utf8").startsWith(`${bashPath(extra)}:`));
		} finally {
			Object.defineProperty(process, "platform", { value: realPlatform });
		}
	});

	test("a failing assignment in ENVRC stops evaluation rather than silently exporting a partial environment (#4588)", async () => {
		const file = path("assignment.envrc");
		writeFileSync(file, "FROM_FAILURE=$(exit 9)\nSHOULD_NOT_RUN=yes\n");
		await assert.rejects(evaluateEnvrc(file, base()), /Sourcing the ENVRC file failed with status 9:/);
	});

	test("an empty file gives the base environment and nothing of the calling process leaks in (#4588)", async () => {
		const file = path("empty.envrc");
		writeFileSync(file, "");
		process.env.BLUEPRINT_ENVRC_LEAK = "leaked";
		try {
			const environment = await evaluateEnvrc(file, base());
			assert.equal(environment.KEEP, "from-base");
			assert.equal(environment.BLUEPRINT_ENVRC_LEAK, undefined);
		} finally {
			delete process.env.BLUEPRINT_ENVRC_LEAK;
		}
	});

	test("a file that makes bash fail rejects with the status and bash's trimmed error output (#4588)", async () => {
		const file = path("failing.envrc");
		writeFileSync(file, "echo boom >&2\nexit 3\n");
		await assert.rejects(
			evaluateEnvrc(file, base()),
			(error: unknown) =>
				error instanceof Error && error.message === "Sourcing the ENVRC file failed with status 3: boom",
		);
	});
});
