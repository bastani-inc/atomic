import { spawnSync } from "node:child_process";
import { bashPath } from "../../src/core/resume/blueprint/envrc.ts";
import { hostPlatform } from "../../src/core/resume/blueprint/schema.ts";
import { getShellConfig } from "../../src/utils/shell.ts";

export function forThisHost(blueprint: string): string {
	return `runs-on: ${hostPlatform()}\n${blueprint}`;
}

export const WORKING_DIRECTORY_COMMAND = process.platform === "win32" ? "pwd -W" : "pwd -P";

export function shellSpelling(directory: string): string {
	if (process.platform !== "win32") return directory;
	const asked = spawnSync(getShellConfig().shell, ["-c", 'cd "$1" && pwd', "bash", bashPath(directory)], {
		encoding: "utf8",
	});
	if (asked.status !== 0) throw new Error(`The shell cannot enter ${directory}: ${asked.stderr}`);
	return asked.stdout.trim();
}
