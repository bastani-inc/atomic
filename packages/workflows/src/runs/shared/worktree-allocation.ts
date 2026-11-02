import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Ownership record stored in a workflow-allocated checkout's own Git directory. */
export const WORKTREE_OWNER_FILENAME = "atomic-workflow-run.json";
const WORKTREE_OWNER_VERSION = 1;
const BUCKET_PATTERN = /^[0-9a-f]{4}$/;
const MAX_BUCKET_ATTEMPTS = 0x10000;

interface WorktreeOwnerRecord {
	readonly version: number;
	readonly ownerRunId: string;
}

let nextBucketIdOverride: (() => string) | undefined;

function nextBucketId(): string {
	return nextBucketIdOverride?.() ?? randomBytes(2).toString("hex");
}

/** Replace the random bucket identifier source while `callback` runs. */
export function withWorktreeBucketIdsForTest<T>(next: () => string, callback: () => T): T {
	const previous = nextBucketIdOverride;
	nextBucketIdOverride = next;
	try {
		return callback();
	} finally {
		nextBucketIdOverride = previous;
	}
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error
		? String((error as { readonly code?: unknown }).code)
		: undefined;
}

/**
 * Reserve a fresh `<root>/<4-hex bucket>` directory and return the checkout path
 * `<bucket>/<repositoryName>` inside it. Creating the bucket is the atomic claim:
 * a bucket that already exists belongs to someone else and another id is tried.
 */
export function allocateWorktreeCheckoutPath(root: string, repositoryName: string): string {
	for (let attempt = 0; attempt < MAX_BUCKET_ATTEMPTS; attempt++) {
		const bucket = path.join(root, nextBucketId());
		try {
			fs.mkdirSync(bucket);
			return path.join(bucket, repositoryName);
		} catch (error) {
			if (errorCode(error) === "EEXIST") continue;
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to create worktree bucket ${bucket} under gitWorktreeDir ${root}: ${message}`);
		}
	}
	throw new Error(`Every worktree bucket identifier under gitWorktreeDir ${root} is already in use.`);
}

/** Remove the bucket that held `checkout` when it is empty; a non-empty bucket is left alone. */
export function removeEmptyWorktreeBucket(checkout: string): void {
	try {
		fs.rmdirSync(path.dirname(checkout));
	} catch {
		// Best effort: a bucket that still has content is not ours to delete.
	}
}

function linkedGitDirectory(checkout: string): string | undefined {
	let pointer: string;
	try {
		if (!fs.lstatSync(path.join(checkout, ".git")).isFile()) return undefined;
		pointer = fs.readFileSync(path.join(checkout, ".git"), "utf8");
	} catch {
		return undefined;
	}
	if (!pointer.startsWith("gitdir:")) return undefined;
	const gitDir = pointer.slice("gitdir:".length).trim();
	return gitDir ? path.resolve(checkout, gitDir) : undefined;
}

function readWorktreeOwner(gitDir: string): string | undefined {
	let contents: string;
	try {
		contents = fs.readFileSync(path.join(gitDir, WORKTREE_OWNER_FILENAME), "utf8");
	} catch {
		return undefined;
	}
	try {
		const record = JSON.parse(contents) as Partial<WorktreeOwnerRecord>;
		return record.version === WORKTREE_OWNER_VERSION && typeof record.ownerRunId === "string" && record.ownerRunId
			? record.ownerRunId
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * List `<root>/<bucket>/<repositoryName>` checkouts whose ownership record names
 * `ownerRunId`. Bucket and checkout aliases (symlinks) are ignored; callers must
 * still validate each candidate with Git before reusing it.
 */
export function findOwnedWorktreeCheckouts(root: string, repositoryName: string, ownerRunId: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const owned: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !BUCKET_PATTERN.test(entry.name)) continue;
		const checkout = path.join(root, entry.name, repositoryName);
		try {
			if (!fs.lstatSync(checkout).isDirectory()) continue;
		} catch {
			continue;
		}
		const gitDir = linkedGitDirectory(checkout);
		if (gitDir !== undefined && readWorktreeOwner(gitDir) === ownerRunId) owned.push(checkout);
	}
	return owned.sort();
}

/** Record `ownerRunId` as the owner of a newly allocated checkout, never replacing another owner. */
export function bindWorktreeOwner(gitDir: string, ownerRunId: string): void {
	const record: WorktreeOwnerRecord = { version: WORKTREE_OWNER_VERSION, ownerRunId };
	fs.writeFileSync(path.join(gitDir, WORKTREE_OWNER_FILENAME), `${JSON.stringify(record)}\n`, {
		encoding: "utf8",
		flag: "wx",
	});
}
