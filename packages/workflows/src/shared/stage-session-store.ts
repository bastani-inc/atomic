import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
	appendForkToolResults,
	assertSessionBlobStore,
	type CreateAgentSessionOptions,
	copySessionBlobs,
	JsonlSessionStore,
	type NewSessionOptions,
	resolveSessionStore,
	type SessionEntry,
	SessionManager,
	type SessionStore,
	sessionBlobHashes,
} from "@bastani/atomic";
import { ForkEntryNotFoundError } from "../durable/fork-errors.js";

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
 * A new session copied from `sessionId` at its leaf, or with `entryId` at that exact entry, with the tool-output blobs
 * the copied entries reference. It copies what the stage's context is built from: what a resume of the source at that
 * entry loads, so the latest clear or compaction boundary on the branch, what it keeps, everything after it, and the
 * settings kept from before it (#5500). A missing entry throws `ForkEntryNotFoundError`, and a destination that cannot
 * hold the blobs `blobs-unsupported`, before anything is written. The copy is append-only: its entries are the
 * source's, unchanged but for the links that chain them into one branch, followed by one result for each tool call the
 * source's last turn left open (#5481).
 */
export async function forkStageSession(
	store: SessionStore,
	sessionId: string,
	cwd: string,
	options: NewSessionOptions,
	destination: SessionStore = store,
	entryId?: string,
): Promise<SessionManager> {
	// Only what the fork's context is built from is read and copied: a resume of the source at the fork point (#5500).
	const branch = await SessionManager.readForkedBranch(store, sessionId, entryId);
	if (branch === undefined && entryId !== undefined)
		throw new ForkEntryNotFoundError({ sessionId, stageName: options.workflow?.stageName, entryId });
	const entries = branch ?? [];
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
