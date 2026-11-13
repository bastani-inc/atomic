import { type InvalidSnapshotReason, WorkspaceRestoreError } from "./errors.ts";
import { redactUrlCredentials } from "./git.ts";
import type { WorkspaceBinding, WorktreeSnapshot } from "./types.ts";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BLOB_HASH = /^[0-9a-f]{64}$/;
const SNAPSHOT_ID = /^[0-9a-f]{1,64}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** The first field of a snapshot or binding record that Git or the filesystem must not receive, and why. */
export interface SnapshotRecordProblem {
	readonly field: string;
	readonly reason: InvalidSnapshotReason;
}

function isObjectId(value: unknown): boolean {
	return typeof value === "string" && OBJECT_ID.test(value);
}

function isBlobHash(value: unknown): boolean {
	return typeof value === "string" && BLOB_HASH.test(value);
}

/** The transports a restore fetches over, and a restored worktree's repository may name as a remote. */
const REMOTE_SCHEMES = new Set(["https", "http", "ssh", "git", "file"]);

/**
 * Whether `remote` is a remote Atomic fetches from and configures: never an option or a control character, without
 * credentials, and a local path, an scp-like `host:path`, or a URL of an allowed transport. A Git remote helper
 * (`ext::`, `<name>::`) or any other scheme is not.
 */
export function isAllowedRemote(remote: string): boolean {
	if (remote.length === 0 || remote.startsWith("-") || CONTROL_CHARACTER.test(remote)) return false;
	if (redactUrlCredentials(remote) !== remote) return false;
	if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(remote)) return false;
	const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(remote)?.[1];
	return scheme === undefined || REMOTE_SCHEMES.has(scheme.toLowerCase());
}

function firstObjectIdProblem(values: unknown, field: string): SnapshotRecordProblem | undefined {
	if (!Array.isArray(values)) return { field, reason: "invalid-object-id" };
	const index = values.findIndex((value) => !isObjectId(value));
	return index < 0 ? undefined : { field: `${field}[${index}]`, reason: "invalid-object-id" };
}

/** The first unsafe remote or malformed object id of a binding, or undefined when every value is safe to use. */
export function bindingRecordProblem(
	binding: Pick<WorktreeSnapshot, "remotes" | "head" | "tree">,
): SnapshotRecordProblem | undefined {
	const remote = binding.remotes.findIndex((value) => !isAllowedRemote(value));
	if (remote >= 0) return { field: `remotes[${remote}]`, reason: "unsafe-remote" };
	if (!isObjectId(binding.head)) return { field: "head", reason: "invalid-object-id" };
	if (!isObjectId(binding.tree)) return { field: "tree", reason: "invalid-object-id" };
	return undefined;
}

/**
 * The first field of a recorded snapshot that is not what Atomic writes: a hex id, safe remotes, Git object ids for
 * every commit and tree, and SHA-256 hashes for every blob. Records come from storage and imports, so they are checked
 * before any value reaches Git or a path.
 */
export function snapshotRecordProblem(snapshot: WorktreeSnapshot): SnapshotRecordProblem | undefined {
	if (!SNAPSHOT_ID.test(snapshot.id)) return { field: "id", reason: "invalid-snapshot-id" };
	const binding = bindingRecordProblem(snapshot);
	if (binding) return binding;
	for (const [index, link] of snapshot.chain.entries()) {
		const entry = (typeof link === "object" && link !== null ? link : {}) as { tree?: unknown; patch?: unknown };
		if (!isObjectId(entry.tree)) return { field: `chain[${index}].tree`, reason: "invalid-object-id" };
		if (entry.patch !== null && !isBlobHash(entry.patch)) {
			return { field: `chain[${index}].patch`, reason: "invalid-blob-hash" };
		}
	}
	if (snapshot.bundle !== null) {
		const bundle = (typeof snapshot.bundle === "object" ? snapshot.bundle : {}) as {
			blob?: unknown;
			commits?: unknown;
		};
		if (!isBlobHash(bundle.blob)) return { field: "bundle.blob", reason: "invalid-blob-hash" };
		const commits = firstObjectIdProblem(bundle.commits, "bundle.commits");
		if (commits) return commits;
	}
	for (const [index, omission] of (Array.isArray(snapshot.omitted) ? snapshot.omitted : []).entries()) {
		if (typeof omission === "object" && omission !== null && "commits" in omission) {
			const commits = firstObjectIdProblem(omission.commits, `omitted[${index}].commits`);
			if (commits) return commits;
		}
	}
	return undefined;
}

function invalidSnapshot(problem: SnapshotRecordProblem, snapshotId: string | null): WorkspaceRestoreError {
	return new WorkspaceRestoreError("invalid-snapshot", {
		snapshotId: snapshotId !== null && SNAPSHOT_ID.test(snapshotId) ? snapshotId : null,
		field: problem.field,
		reason: problem.reason,
	});
}

/**
 * Throws `invalid-snapshot` naming the first unusable field of `binding` or of the `snapshot` it resolves to, before
 * any Git or filesystem work. The offending value is never echoed: it comes from storage and may hold escape codes.
 */
export function assertUsableSnapshotRecord(binding: WorkspaceBinding, snapshot: WorktreeSnapshot | null): void {
	const problem = bindingRecordProblem(binding) ?? (snapshot === null ? undefined : snapshotRecordProblem(snapshot));
	if (problem !== undefined) throw invalidSnapshot(problem, snapshot?.id ?? null);
}

/** Throws `invalid-snapshot` unless every prerequisite a bundle header lists is a Git object id. */
export function assertUsableBundlePrerequisites(prerequisites: readonly string[], snapshotId: string | null): void {
	const problem = firstObjectIdProblem(prerequisites, "bundle.prerequisites");
	if (problem !== undefined) throw invalidSnapshot(problem, snapshotId);
}
