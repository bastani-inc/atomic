import { existsSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { WorkspaceBindingError, WorkspaceSandboxError } from "./errors.ts";
import { type BoundWorkspace, isBoundWorkspace, resolveWorkspace } from "./resolve.ts";
import { restoreWorkspace } from "./restore.ts";
import { assertWorkspace, isWorkspace, recordedRepo, type Workspace } from "./spec.ts";

/** Built-in tools that write files, removed and refused in a read-only workspace. */
export const WORKSPACE_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["write", "edit", "todo"]);

/** Session custom entry that records the resolved binding. */
export const WORKSPACE_BINDING_ENTRY_TYPE = "workspace_binding";

function canonical(path: string): string {
	let existing = path;
	const missing: string[] = [];
	while (!existsSync(existing)) {
		const parent = resolve(existing, "..");
		if (parent === existing) break;
		missing.unshift(basename(existing));
		existing = parent;
	}
	return resolve(realpathSync(existing), ...missing);
}

/**
 * The working directory for a session bound to `binding`: the worktree, or `cwd` resolved against it. A `cwd` that
 * resolves outside the worktree, through `..` or a symbolic link, fails with `cwd-outside-worktree`.
 */
export function workspaceSessionCwd(binding: Pick<BoundWorkspace, "worktree">, cwd?: string): string {
	if (cwd === undefined) return binding.worktree;
	const requested = isAbsolute(cwd) ? cwd : resolve(binding.worktree, cwd);
	const root = canonical(binding.worktree);
	const target = canonical(requested);
	const path = relative(root, target);
	if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))) return target;
	throw new WorkspaceBindingError({
		code: "cwd-outside-worktree",
		fields: { worktree: binding.worktree, cwd: requested },
	});
}

/** The refusal for `toolName` in a read-only binding, or undefined when the call may run. */
export function workspaceSandboxDenial(
	binding: Pick<BoundWorkspace, "sandbox" | "worktree"> | undefined,
	toolName: string,
): WorkspaceSandboxError | undefined {
	if (binding?.sandbox !== "read-only" || !WORKSPACE_WRITE_TOOL_NAMES.has(toolName)) return undefined;
	return new WorkspaceSandboxError({ tool: toolName, worktree: binding.worktree });
}

/**
 * A child session's workspace: its own, or the parent's. A read-only parent stays a ceiling, so a child's own workspace
 * is narrowed to read-only.
 */
export function inheritWorkspace(
	parent: Workspace | BoundWorkspace | undefined,
	child: Workspace | BoundWorkspace | undefined,
): Workspace | BoundWorkspace | undefined {
	if (child === undefined) return parent;
	if (parent?.sandbox !== "read-only") return child;
	if (isWorkspace(child)) return child.readOnly();
	return isBoundWorkspace(child) ? Object.freeze({ ...child, sandbox: "read-only" as const }) : child;
}

interface WorkspaceEntrySource {
	getEntries(): readonly { readonly type: string; readonly customType?: string; readonly data?: unknown }[];
}

function recordedBinding(sessionManager: WorkspaceEntrySource | undefined): BoundWorkspace | undefined {
	const entries = sessionManager?.getEntries() ?? [];
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type === "custom" && entry.customType === WORKSPACE_BINDING_ENTRY_TYPE && isBoundWorkspace(entry.data))
			return entry.data;
	}
	return undefined;
}

function sameWorkspace(spec: Workspace, recorded: BoundWorkspace): boolean {
	return (
		recordedRepo(spec.repo) === recorded.repo &&
		(spec.base === undefined || spec.base === recorded.base) &&
		(spec.branch === undefined || spec.branch === recorded.branch) &&
		(spec.worktree === undefined || spec.worktree === "auto" || spec.worktree === recorded.worktree)
	);
}

/**
 * Bind a session's workspace. A session that already recorded a binding for the same workspace restores that record
 * (verifying it and re-adding a deleted worktree) instead of resolving it again, so its base commit and label survive.
 */
export async function bindSessionWorkspace(
	input: Workspace | BoundWorkspace,
	sessionManager?: WorkspaceEntrySource,
	signal?: AbortSignal,
): Promise<BoundWorkspace> {
	if (isBoundWorkspace(input)) return input;
	assertWorkspace(input, "workspace");
	const recorded = recordedBinding(sessionManager);
	if (recorded === undefined || !sameWorkspace(input, recorded)) return resolveWorkspace(input, { signal });
	await restoreWorkspace(recorded, { signal });
	const label = input.label ?? recorded.label;
	return Object.freeze({ ...recorded, sandbox: input.sandbox, ...(label !== undefined ? { label } : {}) });
}

/** Append the binding to the session unless its latest workspace entry already records it. */
export async function recordSessionWorkspace(
	sessionManager: WorkspaceEntrySource & { appendCustomEntry(customType: string, data?: unknown): Promise<string> },
	binding: BoundWorkspace,
): Promise<void> {
	const recorded = recordedBinding(sessionManager);
	if (recorded !== undefined && JSON.stringify(recorded) === JSON.stringify(binding)) return;
	await sessionManager.appendCustomEntry(WORKSPACE_BINDING_ENTRY_TYPE, binding);
}
