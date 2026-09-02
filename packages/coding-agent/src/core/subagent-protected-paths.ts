import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { SubagentChildPolicy, ToolCallEvent, ToolCallEventResult } from "./extensions/index.ts";

export const SUBAGENT_PROTECTED_PATHS_INPUT = "__atomicProtectedPaths" as const;
export const SUBAGENT_PROTECTED_PATHS_REFUSAL =
	"This foreground investigation cannot mutate a path that was already dirty when it started.";
export const SUBAGENT_PROTECTED_BASH_REFUSAL =
	"Shell execution is disabled while this foreground investigation protects pre-existing dirty paths. Use read, search, find, or ls for inspection and write only new diagnostic paths with write.";
const READ_ONLY_TODO_ACTIONS = new Set(["list", "list-all", "get"]);

function canonicalPath(cwd: string, path: string): string {
	const absolute = resolve(cwd, path);
	return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
}

function writeTarget(input: Record<string, unknown>): string | undefined {
	const path = input.path;
	if (typeof path !== "string" || path.length === 0) return undefined;
	if (path.startsWith("local://")) return path.slice("local://".length);
	return path;
}

function editTargets(input: Record<string, unknown>): string[] {
	if (typeof input.input !== "string") return [];
	const paths: string[] = [];
	for (const line of input.input.split("\n")) {
		const match = /^\[([^\]]+)#[A-Fa-f0-9]{4}\]/u.exec(line.trimStart());
		if (match?.[1]) paths.push(match[1]);
	}
	return paths;
}

function targetMatchesProtected(target: string, cwd: string, protectedPaths: ReadonlySet<string>): boolean {
	if (target.startsWith("conflict://")) return true;
	const plainTarget = target.split(/:(?=[^/\\])/u, 1)[0] ?? target;
	return protectedPaths.has(canonicalPath(cwd, plainTarget));
}

export function guardSubagentProtectedPaths(
	policy: SubagentChildPolicy | undefined,
	cwd: string,
	event: Pick<ToolCallEvent, "toolName" | "input">,
): ToolCallEventResult | undefined {
	if (!policy?.protectedPaths?.length) return undefined;
	const protectedPaths = new Set(policy.protectedPaths.map((path) => canonicalPath(cwd, path)));
	if (event.toolName === "bash" || event.toolName === "powershell") {
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
			? [writeTarget(event.input)].filter((path): path is string => path !== undefined)
			: event.toolName === "edit"
				? editTargets(event.input)
				: [];
	if (targets.some((target) => targetMatchesProtected(target, cwd, protectedPaths))) {
		return { block: true, reason: SUBAGENT_PROTECTED_PATHS_REFUSAL };
	}
	return undefined;
}
