import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { lockHolderAsync, type ProcessRecord, processMayRunAsync } from "../lock-takeover.js";
import { processStartTokenAsync } from "../process-start-token.js";
import { renameWithRetry } from "../rename-retry.ts";
import { unreadablePathError, WorkspaceGitError } from "./errors.ts";
import { canonicalizeWorktreePathAsync } from "./paths.ts";

/** The window for the host-death guardian to finish an orphan before reporting a blocked publication. */
const MOVE_EXIT_WAIT_MS = 5_000;
const MOVE_EXIT_POLL_MS = 50;

interface PublicationFence {
	readonly storeIdentity: string;
	readonly staging: string;
	/** Missing while Git is starting. A crash in that window leaves an ambiguous fence, not a free destination. */
	readonly git?: ProcessRecord;
}

interface PublicationDestination {
	readonly file: string;
	readonly targetIdentity: string | undefined;
}

async function locateDestination(target: string): Promise<PublicationDestination> {
	const existing = await realpath(target).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw unreadablePathError(target, error);
		return undefined;
	});
	const parent = existing === undefined ? await canonicalizeWorktreePathAsync(dirname(target)) : dirname(existing);
	const name = basename(existing ?? target);
	// Use the exact basename on the destination filesystem. Its comparison, not a JavaScript case fold,
	// decides whether two spellings name the same checkout. An existing checkout supplies its on-disk spelling.
	const fenceDirectory = name.toUpperCase() === ".ATOMIC-FENCE" ? ".atomic-fence-alt" : ".atomic-fence";
	return {
		file: join(parent, fenceDirectory, name),
		targetIdentity: existing === undefined ? undefined : await lockHolderAsync(existing),
	};
}

async function createFence(file: string, fence: PublicationFence): Promise<void> {
	const directory = dirname(file);
	for (let attempt = 1; ; attempt++) {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		try {
			// Don't let a symlink redirect the fence to a filesystem with different name equivalence.
			if (!(await lstat(directory)).isDirectory())
				throw new Error(`not a publication fence directory: ${directory}`);
			await writeFile(file, JSON.stringify(fence), { flag: "wx", mode: 0o600 });
			return;
		} catch (error) {
			// A concurrent publisher can remove the empty directory before our exclusive create.
			if (attempt === 4 || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

async function removeFence(file: string): Promise<void> {
	await rm(file, { force: true });
	// A nonempty directory holds another publication's fence; leave it in place.
	await rmdir(dirname(file)).catch(() => {});
}

async function physicalStoreIdentity(store: string): Promise<string> {
	const { dev, ino, birthtimeNs } = await stat(store, { bigint: true });
	return `${dev}:${ino}:${birthtimeNs}`;
}

async function readFence(file: string): Promise<PublicationFence | undefined> {
	let text: string;
	try {
		if (!(await lstat(dirname(file))).isDirectory() || !(await lstat(file)).isFile()) {
			throw new Error(`not a publication fence: ${file}`);
		}
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const value: unknown = JSON.parse(text);
	if (typeof value !== "object" || value === null) throw new Error("unreadable worktree publication record");
	const record = value as Partial<PublicationFence>;
	const git = record.git;
	if (
		typeof record.storeIdentity !== "string" ||
		typeof record.staging !== "string" ||
		(git !== undefined &&
			(typeof git !== "object" ||
				git === null ||
				typeof git.host !== "string" ||
				!Number.isSafeInteger(git.pid) ||
				git.pid <= 0 ||
				(git.started !== undefined && typeof git.started !== "string")))
	)
		throw new Error("unreadable worktree publication record");
	return record as PublicationFence;
}

async function mayStillMove(git: ProcessRecord | undefined): Promise<boolean> {
	return git === undefined || processMayRunAsync(git);
}

/** Under the repository lock, don't sweep a staging worktree out from under its possible orphaned Git move. */
export async function cleanInterruptedPublication<T>(
	store: string,
	target: string,
	staging: string,
	clean: (interrupted: boolean) => Promise<T>,
): Promise<T> {
	const { file } = await locateDestination(target);
	const record = await readFence(file);
	if (record?.staging !== staging) return clean(false);
	if (record.storeIdentity !== (await physicalStoreIdentity(store)))
		throw new Error("the interrupted move's repository has changed");
	if (await mayStillMove(record.git)) throw new Error("the interrupted Git worktree move may still be running");
	const result = await clean(true);
	await removeFence(file);
	return result;
}

/**
 * Fence the target before Git may write it. The caller holds the repository lock and rechecks the destination after
 * admission. An orphan must be gone, not just signaled, before we remove a previous fence and publish to that path.
 */
export async function withPublicationFence<T>(
	store: string,
	target: string,
	staging: string,
	signal: AbortSignal | undefined,
	onWait: (message: string) => void,
	action: (started: (pid: number) => Promise<void>, targetIdentity: string | undefined) => Promise<T>,
): Promise<T> {
	const [{ file, targetIdentity }, storeIdentity] = await Promise.all([
		locateDestination(target),
		physicalStoreIdentity(store),
	]);
	const message = `Waiting for a previous Git worktree move into ${target} to stop`;
	const blocked = (cause?: unknown) =>
		new WorkspaceGitError(
			{
				operation: "worktree move",
				cwd: target,
				exitCode: null,
				detail: `cannot verify that a previous Git worktree move has stopped; use a fresh target or check the process before removing ${file}`,
			},
			cause instanceof Error ? cause : undefined,
		);
	const previous = await readFence(file).catch((error: unknown) => {
		throw blocked(error);
	});
	if (previous !== undefined) {
		// Only the repository lock that published this fence may remove it. Another repository can
		// compete for the same target, but cannot remove a replacement via a different lock.
		if (previous.storeIdentity !== storeIdentity || previous.git === undefined || previous.git.host !== hostname())
			throw blocked();
		const deadline = performance.now() + MOVE_EXIT_WAIT_MS;
		let announced = false;
		while (await mayStillMove(previous.git)) {
			signal?.throwIfAborted();
			if (performance.now() >= deadline) throw blocked();
			if (!announced) {
				announced = true;
				onWait(message);
			}
			await sleep(MOVE_EXIT_POLL_MS);
		}
		await rm(file);
	}
	signal?.throwIfAborted();
	await createFence(file, { storeIdentity, staging });
	try {
		return await action(async (pid) => {
			const git: ProcessRecord = { host: hostname(), pid, started: await processStartTokenAsync(pid) };
			const temporary = join(dirname(file), `.writing-${randomBytes(16).toString("hex")}`);
			try {
				await writeFile(temporary, JSON.stringify({ storeIdentity, staging, git }), { flag: "wx", mode: 0o600 });
				await renameWithRetry(temporary, file);
			} finally {
				await rm(temporary, { force: true }).catch(() => {});
			}
		}, targetIdentity);
	} finally {
		await removeFence(file).catch(() => {});
	}
}
