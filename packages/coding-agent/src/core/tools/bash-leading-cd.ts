import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { getShellEnv } from "../../utils/shell.ts";

export interface LeadingCdSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

// Bash splits words on blanks only; a newline ends the `cd` command itself.
function isBlank(char: string | undefined): boolean {
	return char === " " || char === "\t";
}
function isWordEnd(char: string | undefined): boolean {
	return char === undefined || isBlank(char) || char === "&" || char === ";";
}
// Characters bash takes literally in a word, quoted or not: no expansion, globbing, quoting, redirection or control operator.
const PLAIN_PATH = /^[A-Za-z0-9._/+@%,:=\u0080-\uFFFF-]+$/;

function isPlainPath(pathValue: string): boolean {
	return PLAIN_PATH.test(pathValue) && !pathValue.startsWith("-");
}
// `cd` consults CDPATH for a relative directory unless it starts with `.` or `..`.
function searchesCdPath(pathValue: string, env: NodeJS.ProcessEnv): boolean {
	if (!env.CDPATH || pathValue.startsWith("/")) return false;
	return !/^\.\.?(\/|$)/.test(pathValue);
}

/**
 * Turn `cd <dir> && rest` or `cd <dir>; rest` into `rest` run in `<dir>`, when `<dir>` is one plain word that
 * bash would take literally (optionally wrapped in quotes). Anything else returns undefined, so bash runs the
 * command as written.
 */
export function stripLeadingCdCommand(command: string, cwd: string): LeadingCdSpawnContext | undefined {
	let index = 0;
	while (isBlank(command[index])) index++;
	if (command.slice(index, index + 2) !== "cd" || !isBlank(command[index + 2])) return undefined;
	index += 2;
	while (isBlank(command[index])) index++;
	let rawPath: string;
	let expandsHome = false;
	const quote = command[index];
	if (quote === "'" || quote === '"') {
		const pathStart = index + 1;
		index = command.indexOf(quote, pathStart);
		if (index < 0) return undefined;
		rawPath = command.slice(pathStart, index);
		index++;
	} else {
		const pathStart = index;
		while (!isWordEnd(command[index])) index++;
		rawPath = command.slice(pathStart, index);
		if (rawPath === "~" || rawPath.startsWith("~/")) {
			expandsHome = true;
			rawPath = rawPath.slice(1);
		}
	}
	if (!isPlainPath(expandsHome ? `.${rawPath}` : rawPath)) return undefined;
	while (isBlank(command[index])) index++;
	if (command.startsWith("&&", index)) index += 2;
	else if (command[index] === ";") index++;
	else return undefined;
	while (isBlank(command[index]) || command[index] === "\n") index++;
	const nextCommand = command.slice(index);
	if (!nextCommand || /^[;&|)]/.test(nextCommand)) return undefined;
	const env = { ...getShellEnv() };
	if (!expandsHome && searchesCdPath(rawPath, env)) return undefined;
	const directory = expandsHome ? resolvePath(homedir(), `.${rawPath}`) : resolvePath(cwd, rawPath);
	return { command: nextCommand, cwd: directory, env };
}
