import { spawnSync } from "node:child_process";
import { hostPlatform } from "../../src/core/resume/blueprint/schema.ts";
import { getShellConfig } from "../../src/utils/shell.ts";

export function forThisHost(blueprint: string): string {
	return `runs-on: ${hostPlatform()}\n${blueprint}`;
}

export const WORKING_DIRECTORY_COMMAND = process.platform === "win32" ? "pwd -W" : "pwd -P";

/**
 * `$PWD` of a step that runs in `directory` with `environment`. Git Bash spells a directory below its `/tmp` mount as
 * `/tmp/...` when it starts there, unlike `cd`, so the shell is started there as a step is.
 */
export function shellSpelling(directory: string, environment: NodeJS.ProcessEnv): string {
	if (process.platform !== "win32") return directory;
	const asked = spawnSync(getShellConfig().shell, ["-c", 'printf %s "$PWD"'], {
		cwd: directory,
		env: environment,
		encoding: "utf8",
	});
	if (asked.status !== 0) throw new Error(`The shell cannot enter ${directory}: ${asked.stderr}`);
	return asked.stdout.trim();
}
