import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
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
	readonly store: string;
	readonly staging: string;
	/** Missing while Git is starting. A crash in that window leaves an ambiguous fence, not a free destination. */
	readonly git?: ProcessRecord;
}

async function fencePath(storeDir: string, target: string): Promise<string> {
	const physical = join(await canonicalizeWorktreePathAsync(dirname(target)), basename(target));
	const key = sha256Hex(process.platform === "win32" ? physical.toLowerCase() : physical).slice(0, 24);
	return join(storeDir, "restores", `.publication-${key}`);
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
		typeof record.store !== "string" ||
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
	if (git === undefined || git.host !== hostname()) return true;
	if (process.platform === "linux") {
		// A killed orphan can remain as a zombie until its new parent reaps it. Signal 0 alone sees it as present.
		const line = await readFile(`/proc/${git.pid}/stat`, "utf8").catch(() => "");
		const state = line.slice(line.lastIndexOf(")") + 2, line.lastIndexOf(")") + 3);
		if (state === "Z" || state === "X") return false;
	}
	return processMayRunAsync(git);
}

/** Under the repository lock, don't sweep a staging worktree out from under its possible orphaned Git move. */
export async function cleanInterruptedPublication<T>(
	storeDir: string,
	store: string,
	target: string,
	staging: string,
	clean: (interrupted: boolean) => Promise<T>,
): Promise<T> {
	const file = await fencePath(storeDir, target);
	const record = await readFence(file);
	if (record?.staging !== staging || record.store !== store) return clean(false);
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
	storeDir: string,
	store: string,
	target: string,
	staging: string,
	signal: AbortSignal | undefined,
	onWait: (message: string) => void,
	action: (started: (pid: number) => Promise<void>) => Promise<T>,
): Promise<T> {
	const file = await fencePath(storeDir, target);
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
		if (previous.store !== store || previous.git === undefined || previous.git.host !== hostname()) throw blocked();
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
	await writeFile(file, JSON.stringify({ store, staging }), { flag: "wx", mode: 0o600 });
	try {
		return await action(async (pid) => {
			const git: ProcessRecord = { host: hostname(), pid, started: await processStartTokenAsync(pid) };
			const temporary = `${file}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, JSON.stringify({ store, staging, git }), { flag: "wx", mode: 0o600 });
				await renameWithRetry(temporary, file);
			} finally {
				await rm(temporary, { force: true }).catch(() => {});
			}
		});
	} finally {
		await rm(file, { force: true }).catch(() => {});
	}
}
