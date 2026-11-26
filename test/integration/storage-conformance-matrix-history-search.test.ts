import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type { SessionEntriesQuery, SessionStore } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { createHistoryRouter } from "../../packages/coding-agent/src/core/tools/history-protocol.js";
import type { InternalSearchRequest } from "../../packages/coding-agent/src/core/tools/resource-selectors.js";
import { storageBackends } from "../helpers/storage-backends.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/**
 * A `history://` search reads the entries its index names, and the entries their context shows, a page at a time
 * (#6560). Before, it read each of them alone, a round trip each. This compares the two on random sessions on every
 * backend: a store that refuses the page read makes the search read each entry alone, as it did, and both must answer
 * every search, and every continuation of it, with the same text: the same matches in the same order, cut at the same
 * place by the same budget, with the same cursor.
 */

useTemporaryAgentDir();

const PROJECT = "/projects/read-ahead";
const BASE = Date.parse("2026-11-20T00:00:00.000Z");
const WORDS = ["alpha", "beta", "gamma", "delta", "needle", "haystack", "kappa", "omega", "Needle", "sigma"];
const SESSIONS = 3;
const QUERIES = 16;
/** How many continuations of one search are followed. */
const CONTINUATIONS = 4;
/** Generous for the slowest backend: a search that runs out of time would stop at a place that depends on timing. */
const TIME_MS = 120_000;
const DIFFERENTIAL_TIMEOUT_MS = 600_000;

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 2 ** 32;
	};
}

function sessionEntries(next: () => number, count: number): SessionEntry[] {
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
	const words = (n: number) =>
		Array.from({ length: n }, () => `${pick(WORDS)}${next() < 0.3 ? Math.floor(next() * 9) : ""}`);
	const entries: SessionEntry[] = [];
	for (let index = 0; index < count; index++) {
		const id = `e${index + 1}`;
		const parentId = entries.at(-1)?.id ?? null;
		const timestamp = new Date(BASE + index * 1000).toISOString();
		const roll = next();
		if (roll < 0.1) {
			entries.push({
				type: "custom",
				id,
				parentId,
				timestamp,
				customType: "note",
				data: { text: words(4).join(" ") },
			});
			continue;
		}
		const lines = Array.from({ length: 1 + Math.floor(next() * 4) }, () =>
			words(2 + Math.floor(next() * 5)).join(" "),
		);
		// Now and then an entry larger than a page of reads, which a page read ahead of need stops before.
		if (roll > 0.97) lines.push("x".repeat(70_000));
		const content = lines.join("\n");
		entries.push(
			next() < 0.5
				? { type: "message", id, parentId, timestamp, message: { role: "user", content, timestamp: BASE + index } }
				: {
						type: "message",
						id,
						parentId,
						timestamp,
						message: {
							role: "assistant",
							content: [{ type: "text", text: content }],
							api: "anthropic-messages",
							provider: "anthropic",
							model: "m",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: BASE + index,
						},
					},
		);
	}
	return entries;
}

/** `store` as it searched before: a read of several entries at once fails, so each entry is read alone. */
function readingOneAtATime(store: SessionStore): SessionStore {
	return new Proxy(store, {
		get(target, key) {
			if (key === "readEntryRange")
				return (sessionId: string, query: SessionEntriesQuery) =>
					query.seqs === undefined
						? target.readEntryRange!(sessionId, query)
						: Promise.reject(new Error("one entry at a time"));
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** `store`, counting its range reads. */
function counting(store: SessionStore): {
	readonly store: SessionStore;
	readonly reads: { all: number; ahead: number };
} {
	const reads = { all: 0, ahead: 0 };
	return {
		reads,
		store: new Proxy(store, {
			get(target, key) {
				if (key === "readEntryRange")
					return (sessionId: string, query: SessionEntriesQuery) => {
						reads.all++;
						if (query.seqs !== undefined) reads.ahead++;
						return target.readEntryRange!(sessionId, query);
					};
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}),
	};
}

const CONTINUE = /continue with (history:\/\/\S+?)\]/;

for (const backend of storageBackends) {
	const run = backend.skipReason === undefined ? test : test.skip;
	run(
		`history:// search reads ahead with the same answers as reading entries one at a time on ${backend.name} (#6560)`,
		{ timeout: DIFFERENTIAL_TIMEOUT_MS },
		async () => {
			const scope = await backend.openScope();
			try {
				const sql = await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });
				const next = random(6560);
				const ids: string[] = [];
				for (let session = 0; session < SESSIONS; session++) {
					const id = `random-${session}`;
					ids.push(id);
					await sql.create(
						{ id, version: SESSION_FORMAT_VERSION, createdAt: new Date(BASE).toISOString(), cwd: PROJECT },
						sessionEntries(next, 120 + Math.floor(next() * 140)),
					);
				}
				const ahead = counting(sql);
				const alone = counting(readingOneAtATime(sql));
				const router = (store: SessionStore, bytes: number, rows: number) =>
					createHistoryRouter({
						cwd: PROJECT,
						sessionStore: () => store,
						budget: { bytes, rows, timeMs: TIME_MS },
					});
				// Index every session first, so both searches below take the index's candidates.
				for (const id of ids)
					await router(sql, 1_000_000, 10_000_000).search?.(`history://sessions/${id}`, {
						pattern: "alpha",
						ignoreCase: false,
						literal: false,
						contextBefore: 0,
						contextAfter: 0,
					});
				let compared = 0;
				let cut = 0;
				for (const id of ids) {
					for (let query = 0; query < QUERIES; query++) {
						const word = WORDS[Math.floor(next() * WORDS.length)]!;
						const request: InternalSearchRequest = {
							pattern: next() < 0.3 ? `${word}\\d` : word,
							ignoreCase: next() < 0.3,
							literal: false,
							contextBefore: Math.floor(next() * 4),
							contextAfter: Math.floor(next() * 4),
						};
						const bytes = [400, 1_500, 6_000, 40_000][Math.floor(next() * 4)]!;
						const rows = [25, 120, 250_000][Math.floor(next() * 3)]!;
						const start = next() < 0.3 ? 1 + Math.floor(next() * 100) : undefined;
						let url: string | undefined =
							start === undefined
								? `history://sessions/${id}`
								: `history://sessions/${id}:${start}-${start + 80}`;
						for (let step = 0; url !== undefined && step <= CONTINUATIONS; step++) {
							const read: string = (await router(ahead.store, bytes, rows).search?.(url, request)) ?? "";
							const one: string = (await router(alone.store, bytes, rows).search?.(url, request)) ?? "";
							assert.equal(read, one, `${url} ${JSON.stringify(request)} bytes ${bytes} rows ${rows}`);
							compared++;
							url = CONTINUE.exec(read)?.[1];
							if (url !== undefined) cut++;
						}
					}
				}
				// Not vacuous: searches were cut by their budgets and continued, and reading ahead read less often.
				assert.ok(cut > 10, `${cut} of ${compared} searches were cut`);
				assert.ok(ahead.reads.ahead > 0, "no entries were read ahead");
				const oneAtATime = alone.reads.all - alone.reads.ahead;
				assert.ok(
					ahead.reads.all * 2 < oneAtATime,
					`${ahead.reads.all} reads ahead against ${oneAtATime} one at a time`,
				);
				await sql.close();
			} finally {
				await scope.close();
			}
		},
	);
}
