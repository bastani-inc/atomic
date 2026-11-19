import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
	appendForkToolResults,
	assertSessionBlobStore,
	type CreateAgentSessionOptions,
	copySessionBlobs,
	getSessionLeafId,
	JsonlSessionStore,
	type NewSessionOptions,
	resolveSessionStore,
	type SessionEntry,
	SessionManager,
	type SessionStore,
	sessionBlobHashes,
} from "@bastani/atomic";
import { ForkEntryNotFoundError } from "../durable/fork-errors.js";
import type { StageOptions } from "./types.js";

/** Read the entry a new handle would continue from, without loading the source conversation. */
export async function storedForkPoint(
	options: StageOptions,
	sessionId: string,
	defaultSessionDir?: string,
): Promise<string | null | undefined> {
	const supplied = options.sessionStore ?? options.sessionManager?.getSessionStore();
	const store = supplied ?? (await stageSessionStore(options, defaultSessionDir));
	try {
		if (store.readRange === undefined) return getSessionLeafId((await store.load(sessionId)).entries);
		for (;;) {
			const head = await store.readRange(sessionId, 1, 0);
			if (head.lastSeq === 0) return null;
			const last = await store.readRange(sessionId, head.lastSeq, head.lastSeq);
			// Appends preserve this entry. On replacement, read the new head instead of mixing generations.
			if (head.epoch !== last.epoch || last.entries.length === 0) continue;
			return getSessionLeafId(last.entries);
		}
	} catch (error) {
		// A cached task may no longer have its source. A live task still opens the named session normally.
		if (error instanceof Error && error.name === "SessionNotFoundError") return undefined;
		throw error;
	} finally {
		if (supplied === undefined) await store.close();
	}
}

export async function stageSessionStore(
	options: Pick<CreateAgentSessionOptions, "sessionManager" | "cwd" | "agentDir" | "settingsManager"> & {
		sessionStore?: SessionStore;
		sessionDir?: string;
	},
	defaultSessionDir?: string,
): Promise<SessionStore> {
	if (options.sessionStore !== undefined) return options.sessionStore;
	if (options.sessionManager !== undefined) return options.sessionManager.getSessionStore();
	const directory = options.sessionDir ?? defaultSessionDir;
	if (directory !== undefined) return JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
	return resolveSessionStore(options.cwd ?? process.cwd(), {
		agentDir: options.agentDir,
		settings: options.settingsManager?.getSettings(),
	});
}

/**
 * The result a forked stage's copy of its source holds for a tool call the source had not answered at the fork point,
 * so the stage's first request answers every tool call of the copied conversation (#5481).
 */
export const STAGE_FORK_TOOL_RESULT =
	"This call ran in the session this stage was forked from. Its result went to that session and is not available here.";

/**
 * A new session copied from `sessionId`: every entry, or with `entryId` the branch from the session's root to
 * that exact entry, or with `null` no entry (the source had none at the fork point), with the tool-output blobs
 * those entries reference. A missing entry throws
 * `ForkEntryNotFoundError`, and a destination that cannot hold the blobs `blobs-unsupported`, before anything is
 * written. The copy is append-only: its entries are the source's, unchanged, followed by one result for each tool
 * call the source's last turn left open (#5481).
 */
export async function forkStageSession(
	store: SessionStore,
	sessionId: string,
	cwd: string,
	options: NewSessionOptions,
	destination: SessionStore = store,
	entryId?: string | null,
): Promise<SessionManager> {
	const entries = await forkEntries(store, sessionId, entryId, options.workflow?.stageName);
	const id = randomUUID();
	const hashes = sessionBlobHashes(store, entries);
	assertSessionBlobStore(destination, id, hashes.length);
	await destination.create(
		{
			id,
			version: 4,
			createdAt: new Date().toISOString(),
			cwd,
			parentSessionId: sessionId,
			...(options.internal === true ? { internal: true } : {}),
			...(options.workflow === undefined ? {} : { workflow: options.workflow }),
		},
		entries,
	);
	await copySessionBlobs(store, sessionId, destination, id, hashes);
	const forked = await SessionManager.open(destination, id, cwd, { history: "tail" });
	await appendForkToolResults(forked, () => STAGE_FORK_TOOL_RESULT);
	return forked;
}

/**
 * Import a stage conversation recorded before #3700 into the store it now resumes from.
 *
 * Stage checkpoints written before #3700 point at a JSONL transcript. The session
 * import at startup covers only the default session directory, so a stage whose
 * transcript lives elsewhere (for example a host `--session-dir`) would resume by an
 * ID the selected store has never seen. The transcript is read without rewriting it.
 */
export async function migrateLegacyStageSession(
	store: SessionStore,
	sessionId: string,
	sessionFile: string | undefined,
): Promise<void> {
	if (sessionFile === undefined || (await store.readHeader(sessionId)) !== undefined) return;
	const location = resolve(sessionFile);
	const legacy = await JsonlSessionStore.open(dirname(location), { exactDirectory: true, scanExisting: false });
	try {
		for await (const file of legacy.scanFiles()) {
			if (resolve(file.location) !== location || file.header.id !== sessionId) continue;
			const snapshot = await file.read();
			if ((await store.readHeader(sessionId)) === undefined) await store.create(snapshot.header, snapshot.entries);
			return;
		}
	} finally {
		await legacy.close();
	}
}

/** Keep only the selected branch in memory. Look behind its tip a page at a time; a branch jump skips unrelated pages. */
async function forkEntries(
	store: SessionStore,
	sessionId: string,
	entryId: string | null | undefined,
	stageName?: string,
): Promise<readonly SessionEntry[]> {
	if (entryId === undefined || !store.findEntrySeq || !store.readRange) {
		const { entries } = await store.load(sessionId);
		return entryId === undefined
			? entries
			: entryId === null
				? []
				: sessionBranchTo(entries, entryId, { sessionId, stageName });
	}
	if (entryId === null) {
		await store.readRange(sessionId, 1, 0);
		return [];
	}
	const pageSize = 64;
	for (;;) {
		const path: SessionEntry[] = [];
		let wanted: string | null = entryId;
		let epoch: string | undefined;
		while (wanted !== null) {
			const seq = await store.findEntrySeq(sessionId, wanted);
			if (seq === undefined) {
				if (wanted === entryId) throw new ForkEntryNotFoundError({ sessionId, stageName, entryId });
				if ((await store.readRange(sessionId, 1, 0)).epoch !== epoch) break;
				return path.reverse();
			}
			const page = await store.readRange(sessionId, Math.max(1, seq - pageSize + 1), seq);
			if (page.epoch === undefined) {
				// Without a generation fence the adapter can only supply a consistent branch in one snapshot.
				return sessionBranchTo((await store.load(sessionId)).entries, entryId, { sessionId, stageName });
			}
			if (page.entries.at(-1)?.id !== wanted || (path.length > 0 && epoch !== page.epoch)) break;
			epoch = page.epoch;
			for (let i = page.entries.length - 1; i >= 0; --i) {
				const entry = page.entries[i]!;
				if (entry.id !== wanted) continue;
				path.push(entry);
				wanted = entry.parentId;
			}
		}
		if (wanted === null) return path.reverse();
	}
}

/** The branch of a session from its root to `entryId`, as a fork at that exact entry keeps it. */
export function sessionBranchTo(
	entries: readonly SessionEntry[],
	entryId: string,
	context: { readonly sessionId: string; readonly stageName?: string },
): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	if (!byId.has(entryId)) throw new ForkEntryNotFoundError({ ...context, entryId });
	const branch: SessionEntry[] = [];
	for (let current = byId.get(entryId); current !== undefined; ) {
		branch.push(current);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return branch.reverse();
}
