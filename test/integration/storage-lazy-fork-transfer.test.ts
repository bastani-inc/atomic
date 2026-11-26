import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { exportSessions } from "../../packages/coding-agent/src/core/session-transfer.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { sessionForkTables } from "../../packages/coding-agent/src/core/storage/session/fork-schema.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionStore,
} from "../../packages/coding-agent/src/core/storage/session/types.js";
import { importStorage } from "../../packages/coding-agent/src/core/storage-transfer.js";
import { holdOlderBuildMarker } from "../helpers/older-build-marker.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { type StorageBackend, type StorageBackendScope, storageBackends } from "../helpers/storage-backends.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/**
 * Forks share history inside one store; whatever takes a session out of its store makes a standalone copy (lazy forks).
 * `atomic storage export` reads a forked session through the store's ordinary reads, with the tool outputs it inherited
 * carried inline, so the file restores without the sessions it was forked from, into any backend. Server backends run
 * when their URLs are set (see test/helpers/storage-backends.ts).
 */

useTemporaryAgentDir();

/** A transfer between two backends can wait on two servers. */
const TRANSFER_TIMEOUT_MS = 240_000;
const CWD = "/project";

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: 1_800_000_000_000 };
}

function sha256(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** A fork chain A, B forked from A, C forked from B, each with its own tool output, and both parents continued after their child forked. */
interface Chain {
	readonly ids: { readonly a: string; readonly b: string; readonly c: string };
	/** C as a copy of every row it was forked from holds it: A's entries at B's fork, B's own at C's fork, C's own. */
	readonly copyView: readonly SessionEntry[];
	/** The bytes of every tool output C's history references, by hash. */
	readonly outputs: ReadonlyMap<string, Uint8Array>;
}

async function appendOutput(manager: SessionManager, call: string, outputs: Map<string, Uint8Array>): Promise<void> {
	const data = new Uint8Array(Buffer.from(`${call} output `.repeat(64)));
	outputs.set(sha256(data), data);
	await manager.appendToolOutputBlob(call, data);
}

/**
 * A whole-session clone of `parent`'s stored history, as a store-level fork makes one: in a store with shared-history
 * forks it shares the parent's rows. `forkTo` from a manager holding the whole history writes the rows it holds instead.
 */
async function sharedClone(store: SqlSessionStore, parent: SessionManager): Promise<SessionManager> {
	const parentId = parent.getSessionId();
	const head = await store.readEntrySizes(parentId, 1, 0);
	const id = randomUUID();
	const created = await store.createFork(
		{
			id,
			version: SESSION_FORMAT_VERSION,
			createdAt: new Date().toISOString(),
			cwd: CWD,
			parentSessionId: parentId,
		},
		completeSessionForkStream(parentId, head.epoch, head.lastSeq),
		{ store, sessionId: parentId, epoch: head.epoch, hashes: [], receipts: new Map() },
	);
	assert.ok(created, "the store takes the clone");
	return SessionManager.open(store, id);
}

/**
 * `withOutputs: false` for a JSONL store, which keeps no tool outputs; `shared` forks through the store, so that in a
 * store with shared-history forks each fork shares its parent's rows.
 */
async function buildChain(store: SessionStore, tag: string, withOutputs = true, shared = false): Promise<Chain> {
	const fork = (parent: SessionManager) =>
		shared ? sharedClone(store as SqlSessionStore, parent) : parent.forkTo(CWD, store);
	const outputs = new Map<string, Uint8Array>();
	const output = (manager: SessionManager, call: string) =>
		withOutputs ? appendOutput(manager, call, outputs) : manager.appendMessage(user(`${call} without output`));
	const a = await SessionManager.create(store, CWD);
	await a.appendMessage(user(`${tag} a1`));
	await output(a, `${tag}-a`);
	await a.appendMessage(user(`${tag} a2`));
	const aAtFork = a.getEntries().slice();
	const b = await fork(a);
	const bInherited = b.getEntries().length;
	await b.appendMessage(user(`${tag} b1`));
	await output(b, `${tag}-b`);
	await a.appendMessage(user(`${tag} a3 after the fork`));
	const bOwn = b.getEntries().slice(bInherited);
	const c = await fork(b);
	const cInherited = c.getEntries().length;
	await c.appendMessage(user(`${tag} c1`));
	await output(c, `${tag}-c`);
	await b.appendMessage(user(`${tag} b2 after the fork`));
	const cOwn = c.getEntries().slice(cInherited);
	assert.equal(cInherited, aAtFork.length + bOwn.length, "C inherits exactly A's rows at B's fork and B's own rows");
	return {
		ids: { a: a.getSessionId(), b: b.getSessionId(), c: c.getSessionId() },
		copyView: [...aAtFork, ...bOwn, ...cOwn],
		outputs,
	};
}

/** The lines of an exported session file. */
function exportedLines(directory: string, sessionId: string): string[] {
	return readFileSync(join(directory, "sessions", `${sessionId}.jsonl`), "utf8")
		.trimEnd()
		.split("\n");
}

/** Every exported session file of `directory`, by name. */
function exportedTree(directory: string): Record<string, string> {
	const sessions = join(directory, "sessions");
	return Object.fromEntries(
		readdirSync(sessions)
			.sort()
			.map((name) => [name, readFileSync(join(sessions, name), "utf8")]),
	);
}

/** Checks that an export of C holds the copy view, each inherited tool output inline with its bytes. */
function assertStandaloneExport(lines: readonly string[], chain: Chain): void {
	const header = JSON.parse(lines[0]!) as { type: string; id: string; parentSessionId?: string };
	assert.equal(header.type, "session");
	assert.equal(header.id, chain.ids.c);
	const entries = lines.slice(1).map((line) => JSON.parse(line) as SessionEntry & { data?: { base64?: string } });
	assert.deepEqual(
		entries.map(({ id, parentId, type }) => ({ id, parentId, type })),
		chain.copyView.map(({ id, parentId, type }) => ({ id, parentId, type })),
	);
	const carried = new Map<string, string>();
	for (const entry of entries) {
		const data = entry.data as { hash?: string; base64?: string } | undefined;
		if (data?.hash !== undefined && data.base64 !== undefined) carried.set(data.hash, data.base64);
	}
	assert.deepEqual(
		[...carried.keys()].sort(),
		[...chain.outputs.keys()].sort(),
		"every tool output of the chain, the ancestors' included, is carried inline",
	);
	for (const [hash, base64] of carried)
		assert.deepEqual(new Uint8Array(Buffer.from(base64, "base64")), chain.outputs.get(hash));
}

async function withScope<T>(backend: StorageBackend, body: (scope: StorageBackendScope) => Promise<T>): Promise<T> {
	const scope = await backend.openScope();
	try {
		return await body(scope);
	} finally {
		await scope.close();
	}
}

/**
 * Opens a store under `prefix`. A store shares fork history from its first open; `shared: false` keeps it copying, as a
 * session an older Atomic has open there does.
 */
async function openStore(scope: StorageBackendScope, prefix: string, shared: boolean): Promise<SqlSessionStore> {
	if (!shared) await holdOlderBuildMarker(await scope.connect(), prefix);
	return SqlSessionStore.open(await scope.connect(), { prefix });
}

/** How many fork segments session `id` of the store under `prefix` has: none for a session that holds its history. */
async function segmentCount(scope: StorageBackendScope, prefix: string, id: string): Promise<number> {
	const database = await scope.connect();
	const row = await database.get<{ n: number }>(
		`SELECT count(*) AS n FROM ${sessionForkTables(prefix).forkSegments} WHERE session_id = ?`,
		id,
	);
	return Number(row?.n ?? 0);
}

const label = (backend: StorageBackend) =>
	backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;

for (const backend of storageBackends) {
	describe.skipIf(backend.skipReason !== undefined)(`forked sessions leave ${label(backend)} whole`, () => {
		for (const shared of [false, true])
			test(
				`a depth-3 fork chain exports standalone, survives deleting its ancestors, and re-imports byte for byte, ${shared ? "sharing" : "copying"} history (#6560)`,
				() =>
					withScope(backend, async (scope) => {
						const directory = makeTempDirectory("lazy-fork-export-");
						const prefix = `${scope.prefix}s_`;
						const store = await openStore(scope, prefix, shared);
						try {
							const chain = await buildChain(store, "depth3", true, shared);
							if (shared)
								assert.ok((await segmentCount(scope, prefix, chain.ids.c)) > 0, "C shares A's and B's rows");
							// A store that copies has nothing to detach.
							else assert.deepEqual(await store.detachForks(chain.ids.a), { detached: [], reparented: [] });
							const first = join(directory, "first");
							await exportSessions(store, join(first, "sessions"));
							const exported = exportedLines(first, chain.ids.c);
							assertStandaloneExport(exported, chain);

							// The ancestors go; the child's history, and the export of it, do not change.
							await store.delete(chain.ids.a);
							await store.delete(chain.ids.b);
							assert.deepEqual(
								(await store.load(chain.ids.c)).entries.map((entry) => entry.id),
								chain.copyView.map((entry) => entry.id),
							);
							const again = await exportSessions(store, join(first, "sessions"));
							assert.deepEqual(again.written, [], "the export after the ancestors' deletion is unchanged");
							assert.ok(again.unchanged.includes(chain.ids.c));
							const alone = join(directory, "alone");
							assert.deepEqual((await exportSessions(store, join(alone, "sessions"))).written, [chain.ids.c]);
							assert.deepEqual(exportedLines(alone, chain.ids.c), exported);

							// A store that never held A or B restores C from its file alone, and exports the same bytes.
							const targetPrefix = `${scope.prefix}t_`;
							const target = await openStore(scope, targetPrefix, shared);
							try {
								const report = await importStorage(alone, { sessions: target });
								assert.deepEqual(report.sessions.added, [chain.ids.c]);
								if (shared)
									assert.equal(await segmentCount(scope, targetPrefix, chain.ids.c), 0, "imported standalone");
								assert.equal(await target.readHeader(chain.ids.a), undefined);
								const second = join(directory, "second");
								await exportSessions(target, join(second, "sessions"));
								assert.deepEqual(exportedLines(second, chain.ids.c), exported);
								for (const [hash, data] of chain.outputs)
									assert.deepEqual(await target.getBlob!(chain.ids.c, hash), data);
							} finally {
								await target.close();
							}
						} finally {
							await store.close();
							removeTempDirectory(directory);
						}
					}),
				TRANSFER_TIMEOUT_MS,
			);
	});
}

/** A store to move sessions out of or into: a SQL backend of the matrix with shared-history forks, or a JSONL directory. */
interface Endpoint {
	readonly name: string;
	readonly skipReason: string | undefined;
	open(directory: string): Promise<{ readonly store: SessionStore; close(): Promise<void> }>;
}

function sqlEndpoint(backend: StorageBackend): Endpoint {
	return {
		name: backend.name,
		skipReason: backend.skipReason,
		async open() {
			const scope = await backend.openScope();
			try {
				// Forks share history in the stores sessions move between, as they do once turned on.
				const store = await openStore(scope, scope.prefix, true);
				return {
					store,
					async close() {
						try {
							await store.close();
						} finally {
							await scope.close();
						}
					},
				};
			} catch (error) {
				await scope.close();
				throw error;
			}
		},
	};
}

const jsonlEndpoint: Endpoint = {
	name: "JSONL",
	skipReason: undefined,
	async open(directory) {
		const store = await JsonlSessionStore.open(join(directory, "jsonl"), { exactDirectory: true });
		return { store, close: () => store.close() };
	},
};

const [sqliteFile, postgres] = storageBackends.map(sqlEndpoint) as [Endpoint, Endpoint];
const moves: readonly (readonly [Endpoint, Endpoint])[] = [
	[sqliteFile, postgres],
	[postgres, jsonlEndpoint],
	[jsonlEndpoint, sqliteFile],
	[sqliteFile, jsonlEndpoint],
];

for (const [from, to] of moves) {
	const skip = from.skipReason ?? to.skipReason;
	describe.skipIf(skip !== undefined)(
		`moving a store with fork chains from ${from.name} to ${to.name}${skip === undefined ? "" : ` (skipped: ${skip})`}`,
		() => {
			test(
				"every session arrives standalone and exports the same bytes it left with",
				async () => {
					const directory = makeTempDirectory("lazy-fork-move-");
					const source = await from.open(join(directory, "from"));
					try {
						const outputs = from !== jsonlEndpoint && to !== jsonlEndpoint;
						const shared = from !== jsonlEndpoint;
						const chains = [
							await buildChain(source.store, "one", outputs, shared),
							await buildChain(source.store, "two", outputs, shared),
						];
						const out = join(directory, "out");
						await exportSessions(source.store, join(out, "sessions"));
						for (const chain of chains) assertStandaloneExport(exportedLines(out, chain.ids.c), chain);
						const target = await to.open(join(directory, "to"));
						try {
							const report = await importStorage(out, { sessions: target.store });
							assert.equal(report.sessions.added.length, 6);
							// The children stand alone in the new store: its copies of their ancestors go, and they stay whole.
							for (const chain of chains) {
								await target.store.delete(chain.ids.a);
								await target.store.delete(chain.ids.b);
							}
							const back = join(directory, "back");
							await exportSessions(target.store, join(back, "sessions"));
							const left = exportedTree(out);
							const arrived = exportedTree(back);
							for (const chain of chains)
								assert.equal(arrived[`${chain.ids.c}.jsonl`], left[`${chain.ids.c}.jsonl`]);
						} finally {
							await target.close();
						}
					} finally {
						await source.close();
						removeTempDirectory(directory);
					}
				},
				TRANSFER_TIMEOUT_MS,
			);
		},
	);
}
