import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { getShellEnv } from "../../utils/shell.ts";

export interface LeadingCdSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

function isShellWhitespace(char: string | undefined): boolean { return char === " " || char === "\t" || char === "\n" || char === "\r"; }
function requiresShellExpansion(pathValue: string): boolean { return pathValue.includes("$") || pathValue.includes("`") || pathValue.includes("("); }
function expandHomePath(pathValue: string): string {
	if (pathValue === "~") return homedir();
	if (pathValue.startsWith("~/")) return resolvePath(homedir(), pathValue.slice(2));
	return pathValue;
}

export function stripLeadingCdCommand(command: string, cwd: string): LeadingCdSpawnContext | undefined {
	let index = 0;
	while (isShellWhitespace(command[index])) index++;
	if (command.slice(index, index + 2) !== "cd" || !isShellWhitespace(command[index + 2])) return undefined;
	index += 2;
	while (isShellWhitespace(command[index])) index++;
	let rawPath = "";
	const quote = command[index];
	if (quote === "'" || quote === '"') {
		index++;
		const pathStart = index;
		while (index < command.length && command[index] !== quote) index++;
		if (index >= command.length) return undefined;
		rawPath = command.slice(pathStart, index);
		index++;
	} else {
		const pathStart = index;
		while (index < command.length && command[index] !== "&" && command[index] !== ";") index++;
		rawPath = command.slice(pathStart, index).trim();
	}
	if (!rawPath) return undefined;
	if (requiresShellExpansion(rawPath)) return undefined;
	while (isShellWhitespace(command[index])) index++;
	let separatorLength = 0;
	if (command[index] === "&" && command[index + 1] === "&") separatorLength = 2;
	else if (command[index] === ";") separatorLength = 1;
	else return undefined;
	index += separatorLength;
	while (isShellWhitespace(command[index])) index++;
	const nextCommand = command.slice(index);
	return nextCommand ? { command: nextCommand, cwd: resolvePath(cwd, expandHomePath(rawPath)), env: { ...getShellEnv() } } : undefined;
}
