import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import type { SubagentChildPolicy, ToolCallEvent, ToolCallEventResult } from "./extensions/index.js";
import { parseArchiveSelector, parseSqliteSelector, resolveInternalSelector } from "./tools/resource-selectors.js";

export const SUBAGENT_PROTECTED_PATHS_INPUT = "__atomicProtectedPaths" as const;
export const SUBAGENT_PROTECTED_PATHS_REFUSAL =
	"This foreground investigation cannot mutate a path that was already dirty when it started.";
export const SUBAGENT_PROTECTED_BASH_REFUSAL =
	"Shell command blocked: it is not demonstrably read-only or its explicit mutation target may contain a protected dirty path. Use simple read-only diagnostics or write new diagnostic paths outside protected work.";
const READ_ONLY_TODO_ACTIONS = new Set(["list", "list-all", "get"]);

function canonicalPath(cwd: string, path: string): string {
	const absolute = resolve(cwd, path);
	let ancestor = absolute;
	const suffix: string[] = [];
	while (!existsSync(ancestor)) {
		const parent = dirname(ancestor);
		if (parent === ancestor) break;
		suffix.unshift(basename(ancestor));
		ancestor = parent;
	}
	return resolve(realpathSync.native(ancestor), ...suffix);
}

function pathsOverlap(left: string, right: string): boolean {
	const leftPrefix = left.endsWith(sep) ? left : `${left}${sep}`;
	const rightPrefix = right.endsWith(sep) ? right : `${right}${sep}`;
	return left === right || left.startsWith(rightPrefix) || right.startsWith(leftPrefix);
}

interface MutationTarget {
	path?: string;
	conservativeBlock?: boolean;
}

function mutationTarget(path: string, cwd: string): MutationTarget {
	if (path.startsWith("conflict://")) return { conservativeBlock: true };
	const archive = parseArchiveSelector(path);
	if (archive) return { path: archive.archivePath };
	const sqlite = parseSqliteSelector(path);
	if (sqlite?.table) return { path: sqlite.databasePath };
	if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(path)) {
		const resolved = resolveInternalSelector(path, cwd);
		return resolved === undefined ? { conservativeBlock: true } : { path: resolved };
	}
	return { path };
}

function writeTarget(input: Record<string, unknown>, cwd: string): MutationTarget | undefined {
	const path = input.path;
	return typeof path === "string" && path.length > 0 ? mutationTarget(path, cwd) : undefined;
}

function editTargets(input: Record<string, unknown>, cwd: string): MutationTarget[] {
	if (typeof input.input !== "string") return [];
	const targets: MutationTarget[] = [];
	for (const line of input.input.split("\n")) {
		const match = /^\[([^\]]+)#[A-Fa-f0-9]{4}\]/u.exec(line.trimStart());
		if (match?.[1]) targets.push(mutationTarget(match[1], cwd));
	}
	return targets;
}

function targetMatchesProtected(target: MutationTarget, cwd: string, protectedPaths: ReadonlySet<string>): boolean {
	if (target.conservativeBlock === true) return true;
	if (target.path === undefined) return false;
	const candidate = canonicalPath(cwd, target.path);
	return [...protectedPaths].some((protectedPath) => pathsOverlap(candidate, protectedPath));
}

const SIMPLE_SHELL_TOKEN = String.raw`(?:[^\s'"]+|'[^']*'|"[^"]*")`;
const SIMPLE_SHELL_SEGMENT = new RegExp(`^${SIMPLE_SHELL_TOKEN}(?:\\s+${SIMPLE_SHELL_TOKEN})*\\s*$`, "u");
const SIMPLE_SHELL_TOKEN_PATTERN = new RegExp(SIMPLE_SHELL_TOKEN, "gu");
const FORBIDDEN_SHELL_SYNTAX = /[;&|<>`$(){}*?[\]!\\\r\n]/u;

function parseSimpleShellSegment(segment: string): string[] | undefined {
	const trimmed = segment.trim();
	if (!SIMPLE_SHELL_SEGMENT.test(trimmed)) return undefined;
	return [...trimmed.matchAll(SIMPLE_SHELL_TOKEN_PATTERN)].map((match) => {
		const token = match[0];
		return token.startsWith("'") || token.startsWith('"') ? token.slice(1, -1) : token;
	});
}

function parseSimpleShellCommand(command: string): string[][] | undefined {
	const withoutConjunctions = command.replaceAll("&&", "");
	if (FORBIDDEN_SHELL_SYNTAX.test(withoutConjunctions)) return undefined;
	const segments = command.split("&&").map(parseSimpleShellSegment);
	return segments.some((segment) => segment === undefined) ? undefined : (segments as string[][]);
}

const READ_ONLY_COMMANDS = new Set([
	"cat",
	"echo",
	"file",
	"get-childitem",
	"get-content",
	"get-location",
	"grep",
	"head",
	"ls",
	"printf",
	"pwd",
	"select-string",
	"stat",
	"tail",
	"test",
	"test-path",
	"true",
	"false",
	"wc",
]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"cat-file",
	"describe",
	"diff",
	"log",
	"ls-files",
	"rev-parse",
	"show",
	"status",
]);

function isReadOnlyGit(words: readonly string[]): boolean {
	const subcommand = words[1]?.toLowerCase();
	if (!subcommand || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return false;
	return !words.some((word) =>
		["--ext-diff", "--output", "--exec", "--paginate", "--textconv"].some(
			(option) => word === option || word.startsWith(`${option}=`),
		),
	);
}

function isReadOnlyFind(words: readonly string[]): boolean {
	return !words.some((word) =>
		["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint", "-fprint0", "-fprintf"].includes(word),
	);
}

function isReadOnlyNodeCheck(words: readonly string[]): boolean {
	return words.length >= 3 && words[1] === "--check" && words.slice(2).every((word) => !word.startsWith("-"));
}

const MUTATION_COMMAND_OPTIONS: Readonly<Record<string, RegExp>> = {
	mkdir: /^(?:-p|--parents|--)$/u,
	touch: /^(?:-c|--no-create|--)$/u,
	rm: /^(?:--|--force|--recursive|--dir|-[frd]+)$/u,
};

function explicitMutationPaths(words: readonly string[]): string[] | undefined {
	const allowedOptions = MUTATION_COMMAND_OPTIONS[words[0]?.toLowerCase() ?? ""];
	if (!allowedOptions) return undefined;
	const arguments_ = words.slice(1);
	if (arguments_.some((word) => word.startsWith("-") && !allowedOptions.test(word))) return undefined;
	return arguments_.filter((word) => !word.startsWith("-"));
}

function pathContainsProtected(path: string, cwd: string, protectedPaths: ReadonlySet<string>): boolean {
	const candidate = canonicalPath(cwd, path);
	return [...protectedPaths].some((protectedPath) => pathsOverlap(candidate, protectedPath));
}

function segmentIsSafe(words: readonly string[], cwd: string, protectedPaths: ReadonlySet<string>): boolean {
	const command = words[0]?.toLowerCase();
	if (!command || command.includes("/") || command.includes("\\")) return false;
	let safe = READ_ONLY_COMMANDS.has(command);
	if (command === "git") safe = isReadOnlyGit(words);
	else if (command === "find") safe = isReadOnlyFind(words);
	else if (command === "node") safe = isReadOnlyNodeCheck(words);
	else if (!safe) {
		const mutationPaths = explicitMutationPaths(words);
		safe =
			mutationPaths !== undefined &&
			mutationPaths.length > 0 &&
			mutationPaths.every((path) => !pathContainsProtected(path, cwd, protectedPaths));
	}
	return safe;
}

function isSafeProtectedShellCommand(
	input: Record<string, unknown>,
	cwd: string,
	protectedPaths: ReadonlySet<string>,
): boolean {
	if (typeof input.command !== "string") return false;
	const commandCwd = typeof input.cwd === "string" ? canonicalPath(cwd, input.cwd) : cwd;
	const segments = parseSimpleShellCommand(input.command);
	return segments?.every((segment) => segmentIsSafe(segment, commandCwd, protectedPaths)) ?? false;
}

export function guardSubagentProtectedPaths(
	policy: SubagentChildPolicy | undefined,
	cwd: string,
	event: Pick<ToolCallEvent, "toolName" | "input">,
): ToolCallEventResult | undefined {
	if (!policy?.protectedPaths?.length) return undefined;
	const protectedPaths = new Set(policy.protectedPaths.map((path) => canonicalPath(cwd, path)));
	if (
		(event.toolName === "bash" || event.toolName === "powershell") &&
		!isSafeProtectedShellCommand(event.input, cwd, protectedPaths)
	) {
		return { block: true, reason: SUBAGENT_PROTECTED_BASH_REFUSAL };
	}
	if (
		event.toolName === "todo" &&
		!READ_ONLY_TODO_ACTIONS.has(String((event.input as Record<string, unknown>).action))
	) {
		return { block: true, reason: SUBAGENT_PROTECTED_PATHS_REFUSAL };
	}
	const targets =
		event.toolName === "write"
			? [writeTarget(event.input, cwd)].filter((target): target is MutationTarget => target !== undefined)
			: event.toolName === "edit"
				? editTargets(event.input, cwd)
				: [];
	if (targets.some((target) => targetMatchesProtected(target, cwd, protectedPaths))) {
		return { block: true, reason: SUBAGENT_PROTECTED_PATHS_REFUSAL };
	}
	return undefined;
}
