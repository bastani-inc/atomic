/**
 * Setup-hook commands that every platform shell runs the same way (`/bin/sh` on POSIX, `cmd.exe` on Windows): Node
 * evaluating a short script.
 */

/** Node evaluating `script`, which must not contain double quotes. */
export function nodeCommand(script: string): string {
	return `"${process.execPath}" -e "${script}"`;
}

/** A command that succeeds without output. */
export const SUCCEEDING_COMMAND = nodeCommand("process.exit(0)");

/** A command that keeps running for 30 seconds unless it is stopped. */
export const SLEEPING_COMMAND = nodeCommand("setTimeout(() => {}, 30000)");

/** A command that creates `file` once it is running, then keeps running for 30 seconds unless it is stopped. */
export function startedSleepingCommand(file: string): string {
	return nodeCommand(`require('fs').writeFileSync('${file.replaceAll("\\", "/")}', '');setTimeout(() => {}, 30000)`);
}

/** A command that appends `line` and a newline to `file`. */
export function appendLineCommand(file: string, line: string): string {
	return nodeCommand(`require('fs').appendFileSync('${file.replaceAll("\\", "/")}', '${line}\\n')`);
}

/** A path for a POSIX shell script on any platform: Git Bash reads forward slashes on Windows. */
export function shellPath(path: string): string {
	return path.replaceAll("\\", "/");
}
