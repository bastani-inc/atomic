import { isAbsolute } from "node:path";
import { WorkspaceConfigError, type WorkspaceConfigSource } from "./errors.ts";
import { redactCredentials } from "./redact.ts";

export type WorkspaceSandbox = "workspace-write" | "read-only";

export interface WorkspaceOptions {
	/** Absolute path of a local repository root, or a remote (`https://…`, `ssh://…`, `git@host:owner/repo`, `host/owner/repo`). */
	readonly repo: string;
	/** Commit-ish new branches start from. Default: the local repository's HEAD, or the remote's default branch. */
	readonly base?: string;
	/** Branch the worktree is on, created from `base` when missing. Default: the current or default branch. */
	readonly branch?: string;
	/** `"auto"` (default) or an absolute path. */
	readonly worktree?: string;
	/** Default `"workspace-write"`. `"read-only"` removes file-writing tools from sessions bound to it. */
	readonly sandbox?: WorkspaceSandbox;
	/** Caller label recorded with the binding and kept through resume. */
	readonly label?: string;
}

/** A validated, unresolved workspace. Resolution happens when a session or child workflow binds to it. */
export interface Workspace {
	readonly kind: "workspace";
	readonly repo: string;
	readonly base?: string;
	readonly branch?: string;
	readonly worktree?: string;
	readonly sandbox: WorkspaceSandbox;
	readonly label?: string;
	/** The same workspace with `sandbox: "read-only"`. */
	readOnly(): Workspace;
}

export type WorkspaceRepository =
	| { readonly kind: "local"; readonly path: string }
	| {
			readonly kind: "remote";
			readonly url: string;
			readonly host: string;
			readonly segments: readonly string[];
	  };

const SANDBOXES: readonly WorkspaceSandbox[] = ["workspace-write", "read-only"];
const URL_REMOTE = /^(?:https?|ssh|git|file):\/\//i;
const SCP_REMOTE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/;
const HOST_SHORTHAND = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?)\/([^/\s]+(?:\/[^/\s]+)+)$/i;

function pathSegments(path: string): string[] {
	return path
		.split("/")
		.filter((segment) => segment !== "")
		.map((segment, index, all) => (index === all.length - 1 ? segment.replace(/\.git$/i, "") : segment));
}

/** Classify a `repo` value as a local path or a remote. Returns `undefined` for anything else. */
export function classifyRepository(repo: string): WorkspaceRepository | undefined {
	if (URL_REMOTE.test(repo)) {
		if (!URL.canParse(repo)) return undefined;
		const parsed = new URL(repo);
		const segments = pathSegments(parsed.pathname);
		if (segments.length === 0) return undefined;
		return { kind: "remote", url: repo, host: parsed.host || parsed.protocol.replace(/:$/, ""), segments };
	}
	if (isAbsolute(repo)) return { kind: "local", path: repo };
	const shorthand = HOST_SHORTHAND.exec(repo);
	if (shorthand !== null) {
		return { kind: "remote", url: `https://${repo}`, host: shorthand[1]!, segments: pathSegments(shorthand[2]!) };
	}
	const scp = SCP_REMOTE.exec(repo);
	if (scp !== null) {
		const segments = pathSegments(scp[2]!);
		if (segments.length > 0) return { kind: "remote", url: repo, host: scp[1]!, segments };
	}
	return undefined;
}

function configError(
	source: WorkspaceConfigSource,
	field: string,
	value: unknown,
	expected: string,
): WorkspaceConfigError {
	return new WorkspaceConfigError({
		source,
		field,
		reason: value === undefined ? "missing" : typeof value === "string" ? "invalid-value" : "invalid-type",
		expected,
		received: value === undefined ? "undefined" : typeof value === "string" ? "an unsupported string" : typeof value,
	});
}

function optionalString(
	options: Readonly<Record<string, unknown>>,
	field: keyof WorkspaceOptions,
	expected: string,
	valid: (value: string) => boolean,
): string | undefined {
	const value = options[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !valid(value)) throw configError("sdk", `workspace.${field}`, value, expected);
	return value;
}

function validBranch(value: string): boolean {
	return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function freeze(spec: Omit<Workspace, "kind" | "readOnly">): Workspace {
	let readOnly: Workspace | undefined;
	const value: Workspace = Object.freeze({
		kind: "workspace",
		repo: spec.repo,
		...(spec.base !== undefined ? { base: spec.base } : {}),
		...(spec.branch !== undefined ? { branch: spec.branch } : {}),
		...(spec.worktree !== undefined ? { worktree: spec.worktree } : {}),
		sandbox: spec.sandbox,
		...(spec.label !== undefined ? { label: spec.label } : {}),
		// One read-only value per workspace, so every reviewer bound to it shares one resolution.
		readOnly: () => {
			if (spec.sandbox === "read-only") return value;
			readOnly ??= freeze({ ...spec, sandbox: "read-only" });
			return readOnly;
		},
	});
	return value;
}

/**
 * Declare the repository, branch and worktree a session or child workflow works in. Validates the options and throws
 * `WorkspaceConfigError` before any git or filesystem work; values are kept verbatim.
 */
export function workspace(options: WorkspaceOptions): Workspace {
	if (typeof options !== "object" || options === null) throw configError("sdk", "workspace", options, "an object");
	const record = options as unknown as Readonly<Record<string, unknown>>;
	const repo = record.repo;
	if (typeof repo !== "string" || classifyRepository(repo) === undefined)
		throw configError("sdk", "workspace.repo", repo, "an absolute repository path or a remote URL");
	const base = optionalString(record, "base", "a non-empty commit-ish", (value) => value.length > 0);
	const branch = optionalString(record, "branch", "a branch name without empty, . or .. segments", validBranch);
	const worktree = optionalString(
		record,
		"worktree",
		'"auto" or an absolute path',
		(value) => value === "auto" || isAbsolute(value),
	);
	const sandbox = optionalString(record, "sandbox", '"workspace-write" or "read-only"', (value) =>
		SANDBOXES.includes(value as WorkspaceSandbox),
	) as WorkspaceSandbox | undefined;
	const label = optionalString(record, "label", "a string", () => true);
	return freeze({ repo, base, branch, worktree, sandbox: sandbox ?? "workspace-write", label });
}

/** Reject a value passed as `field` that is not a `workspace({ … })` value, before any git or filesystem work. */
export function assertWorkspace(value: unknown, field: string): asserts value is Workspace {
	if (!isWorkspace(value)) throw configError("sdk", field, value, "a value returned by workspace({ … })");
}

export function isWorkspace(value: unknown): value is Workspace {
	const candidate = value as Partial<Workspace> | null | undefined;
	return candidate?.kind === "workspace" && typeof candidate.repo === "string";
}

/** The `repo` value as recorded and reported: credentials removed, otherwise verbatim. */
export function recordedRepo(repo: string): string {
	return redactCredentials(repo);
}
