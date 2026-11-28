import { randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type ProcessRecord, processMayRunAsync } from "../lock-takeover.js";
import { processStartTokenAsync } from "../process-start-token.js";
import { renameWithRetry } from "../rename-retry.ts";
import { sha256Hex } from "./env-hash.ts";
import { WorkspaceGitError } from "./errors.ts";
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

async function fencePath(target: string): Promise<string> {
	// Put the fence in the physical parent (including on-disk case), not in a store chosen by the caller.
	// The destination may not exist yet; conservatively join case and Unicode aliases of its basename.
	const parent = await canonicalizeWorktreePathAsync(dirname(target));
	const key = sha256Hex(basename(target).normalize("NFD").toUpperCase()).slice(0, 24);
	return join(parent, `.atomic-publication-${key}`);
}

async function physicalStoreIdentity(store: string): Promise<string> {
	const { dev, ino, birthtimeNs } = await stat(store, { bigint: true });
	return `${dev}:${ino}:${birthtimeNs}`;
}

async function readFence(file: string): Promise<PublicationFence | undefined> {
	let text: string;
	try {
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
	const file = await fencePath(target);
	const record = await readFence(file);
	if (record?.staging !== staging) return clean(false);
	if (record.storeIdentity !== (await physicalStoreIdentity(store)))
		throw new Error("the interrupted move's repository has changed");
	if (await mayStillMove(record.git)) throw new Error("the interrupted Git worktree move may still be running");
	const result = await clean(true);
	await rm(file);
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
	action: (started: (pid: number) => Promise<void>) => Promise<T>,
): Promise<T> {
	const [file, storeIdentity] = await Promise.all([fencePath(target), physicalStoreIdentity(store)]);
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
	await writeFile(file, JSON.stringify({ storeIdentity, staging }), { flag: "wx", mode: 0o600 });
	try {
		return await action(async (pid) => {
			const git: ProcessRecord = { host: hostname(), pid, started: await processStartTokenAsync(pid) };
			const temporary = `${file}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, JSON.stringify({ storeIdentity, staging, git }), { flag: "wx", mode: 0o600 });
				await renameWithRetry(temporary, file);
			} finally {
				await rm(temporary, { force: true }).catch(() => {});
			}
		});
	} finally {
		await rm(file, { force: true }).catch(() => {});
	}
}
