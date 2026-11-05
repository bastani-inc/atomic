import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { bunExecutable } from "../../../test/helpers/runtime.js";
import { ENV_AGENT_DIR } from "../src/config.js";

const isWindows = process.platform === "win32";
const ORIGINAL_PATH = process.env.PATH ?? "";
const BUN_EXECUTABLE = bunExecutable();

function pathOf(env: NodeJS.ProcessEnv): string | undefined {
	return env[Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH"];
}

describe("agent shell git PATH (#4322)", () => {
	let tempDir: string;
	let binDir: string;
	let emptyDir: string;
	let gitBinDir: string;
	let getShellEnv: typeof import("../src/utils/shell.js").getShellEnv;

	function writeExecutable(path: string, body: string): void {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, body);
		chmodSync(path, 0o755);
	}

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "atomic-shell-git-"));
		binDir = join(tempDir, "agent", "bin");
		gitBinDir = join(binDir, "git", isWindows ? "cmd" : "bin");
		emptyDir = join(tempDir, "empty");
		mkdirSync(emptyDir);
		vi.stubEnv(ENV_AGENT_DIR, join(tempDir, "agent"));
		vi.stubEnv("PATH", emptyDir);
		vi.stubEnv("GIT_EXEC_PATH", undefined);
		vi.resetModules();
		({ getShellEnv } = await import("../src/utils/shell.js"));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("puts the provisioned git first, with its environment, when no git is on PATH", () => {
		const executable = join(gitBinDir, isWindows ? "git.exe" : "git");
		if (isWindows) {
			const source = join(tempDir, "git-version.ts");
			writeFileSync(source, 'process.stdout.write("git version 2.56.0\\n");\n');
			mkdirSync(gitBinDir, { recursive: true });
			const built = spawnSync(BUN_EXECUTABLE, ["build", "--compile", source, "--outfile", executable], {
				env: { ...process.env, PATH: ORIGINAL_PATH },
				encoding: "utf8",
			});
			assert.equal(built.status, 0, `${built.stderr}${built.stdout}`);
		} else writeExecutable(executable, '#!/bin/sh\necho "git version 2.56.0"\n');
		const env = getShellEnv();
		assert.equal(pathOf(env), [gitBinDir, binDir, emptyDir].join(delimiter));
		const architectureDirectory =
			process.arch === "arm64" ? "clangarm64" : process.arch === "ia32" ? "mingw32" : "ucrt64";
		assert.equal(
			env.GIT_EXEC_PATH,
			isWindows
				? join(binDir, "git", architectureDirectory, "libexec", "git-core")
				: join(binDir, "git", "libexec", "git-core"),
		);
	});

	it("leaves PATH to the user's git, even an old one", () => {
		writeExecutable(join(gitBinDir, isWindows ? "git.exe" : "git"), "");
		const systemDir = join(tempDir, "system");
		writeExecutable(join(systemDir, isWindows ? "git.exe" : "git"), "");
		vi.stubEnv("PATH", systemDir);
		const env = getShellEnv();
		assert.equal(pathOf(env), [binDir, systemDir].join(delimiter));
		assert.equal(env.GIT_EXEC_PATH, undefined);
	});

	it("adds only the managed bin directory when git is not provisioned", () => {
		assert.equal(pathOf(getShellEnv()), [binDir, emptyDir].join(delimiter));
		vi.stubEnv("PATH", [binDir, emptyDir].join(delimiter));
		assert.equal(pathOf(getShellEnv()), [binDir, emptyDir].join(delimiter));
	});

	it("adds no trailing separator to an empty PATH", () => {
		vi.stubEnv("PATH", "");
		assert.equal(pathOf(getShellEnv()), binDir);
	});

	it.skipIf(isWindows)("lets an agent shell run the provisioned git", () => {
		writeExecutable(
			join(gitBinDir, "git"),
			'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.56.0"; exit 0; fi\necho "portable git $GIT_EXEC_PATH"\n',
		);
		const result = spawnSync("/bin/sh", ["-c", "git --check-helpers"], { env: getShellEnv(), encoding: "utf-8" });
		assert.equal(result.stdout.trim(), `portable git ${join(binDir, "git", "libexec", "git-core")}`);
	});
});
