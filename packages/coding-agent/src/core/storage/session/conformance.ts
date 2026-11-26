import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Usage } from "@bastani/atomic-ai/compat";
import { buildSessionProjection, getSessionLeafId } from "../../session-manager-history.ts";
import type { SessionEntry } from "../../session-manager-types.ts";
import {
	SessionConflictError,
	SessionExistsError,
	SessionIdMismatchError,
	SessionInvalidTextError,
	SessionInvalidTimestampError,
	SessionNotFoundError,
	type SessionTextField,
	StoreClosedError,
} from "./errors.js";
import { readSessionHistory, readSessionHistoryChunks } from "./history-pages.js";
import { SESSION_SUMMARY_TEXT_CHARS } from "./session-summary.js";
import {
	SESSION_FORMAT_VERSION,
	SESSION_HISTORY_CHUNK_BYTES,
	SESSION_HISTORY_PAGE_BYTES,
	SESSION_HISTORY_SCAN_ENTRIES,
	type SessionHistoryItem,
	type SessionHistoryTotals,
	type SessionRecordHeader,
	type SessionScanPage,
	type SessionStore,
	type SessionSummary,
} from "./types.js";

export interface SessionStoreConformanceRunner {
	describe(name: string, body: () => void): void;
	/** `timeoutMs`, when given, is the case's own time limit: the cases that store tens of megabytes pass one. */
	it(name: string, body: () => Promise<void>, timeoutMs?: number): void;
}

/** The time limit of a case that writes and reads tens of megabytes, as it takes over HTTP to a loaded server. */
const LARGE_VALUE_TIMEOUT_MS = 300_000;

export interface SessionStoreConformanceSubject {
	store: SessionStore;
	reopen(): Promise<SessionStore>;
}

export type WithSessionStore = (body: (subject: SessionStoreConformanceSubject) => Promise<void>) => Promise<void>;

type Reload = (store: SessionStore) => Promise<SessionStore>;

const createdAt = "2026-10-15T00:00:00.000Z";

function header(id = "session"): SessionRecordHeader {
	return { id, version: SESSION_FORMAT_VERSION, createdAt, cwd: "/project" };
}

/** Entry `i` of a scan's session as a tool result (10, 200), a call of another tool (20) or of `bash` (30). */
function toolUse(i: number, entry: SessionEntry): SessionEntry {
	const base = { ...entry, type: "message" } as const;
	const call = (name: string) => ({
		...base,
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: `call-${i}`,
					name,
					arguments: { text: (entry as { message: { content: string } }).message.content },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		},
	});
	if (i === 9 || i === 199)
		return {
			...base,
			message: {
				role: "toolResult",
				toolCallId: `call-${i}`,
				toolName: i === 9 ? "bash" : "custom",
				content: [{ type: "text", text: "r" }],
				isError: false,
				timestamp: 1,
			},
		} as SessionEntry;
	if (i === 19) return call("custom") as SessionEntry;
	if (i === 29) return call("bash") as SessionEntry;
	return entry;
}

function message(id: string, text: string, timestamp = Date.parse(createdAt)): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "user", content: text, timestamp },
	};
}

async function collect(store: SessionStore, query = {}): Promise<SessionSummary[]> {
	const summaries: SessionSummary[] = [];
	for await (const summary of store.list(query)) summaries.push(summary);
	return summaries;
}

function notFound(sessionId: string): (error: Error) => boolean {
	return (error) => {
		assert.ok(error instanceof SessionNotFoundError);
		assert.equal(error.sessionId, sessionId);
		return true;
	};
}

function conflict(sessionId: string, expectedSeq: number, actualSeq: number): (error: Error) => boolean {
	return (error) => {
		assert.ok(error instanceof SessionConflictError, `${error.name}: ${error.message}`);
		assert.equal(error.sessionId, sessionId);
		assert.equal(error.expectedSeq, expectedSeq);
		assert.equal(error.actualSeq, actualSeq);
		return true;
	};
}

function invalidText(
	field: SessionTextField,
	reason: "nul-character" | "ill-formed-unicode",
): (error: Error) => boolean {
	return (error) => {
		assert.ok(error instanceof SessionInvalidTextError);
		assert.equal(error.field, field);
		assert.equal(error.reason, reason);
		return true;
	};
}

function tailUsage(tokens: number): Usage {
	return {
		input: tokens,
		output: 1,
		cacheRead: 2,
		cacheWrite: 3,
		totalTokens: tokens + 6,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens / 128 },
	};
}

function chained(entries: readonly (Omit<SessionEntry, "parentId" | "timestamp"> & { parent?: string | null })[]) {
	const result: SessionEntry[] = [];
	for (const [index, { parent, ...entry }] of entries.entries()) {
		const timestamp = new Date(Date.parse(createdAt) + index * 1000).toISOString();
		const parentId = parent === undefined ? (result.at(-1)?.id ?? null) : parent;
		const { type, id, customType, data, ...body } = entry as { type: string; id: string; [key: string]: unknown };
		result.push(
			(type === "custom"
				? { type, customType, data, id, parentId, timestamp }
				: { type, id, parentId, timestamp, ...body }) as unknown as SessionEntry,
		);
	}
	return result;
}

const tailEntry = {
	user: (id: string, text = id, parent?: string | null) => ({
		type: "message" as const,
		id,
		...(parent === undefined ? {} : { parent }),
		message: { role: "user" as const, content: text, timestamp: Date.parse(createdAt) },
	}),
	assistant: (id: string, tokens: number, parent?: string | null) => ({
		type: "message" as const,
		id,
		...(parent === undefined ? {} : { parent }),
		message: {
			role: "assistant" as const,
			content: [
				{ type: "text" as const, text: id },
				{ type: "toolCall" as const, id: `call-${id}`, name: "read", arguments: {} },
			],
			api: "anthropic-messages" as const,
			provider: "test",
			model: "model",
			usage: tailUsage(tokens),
			stopReason: "toolUse" as const,
			timestamp: Date.parse(createdAt),
		},
	}),
	model: (id: string, parent?: string | null) => ({
		type: "model_change" as const,
		id,
		...(parent === undefined ? {} : { parent }),
		provider: "test",
		modelId: id,
	}),
	thinking: (id: string, parent?: string | null) => ({
		type: "thinking_level_change" as const,
		id,
		...(parent === undefined ? {} : { parent }),
		thinkingLevel: "high",
	}),
	label: (id: string, targetId: string) => ({ type: "label" as const, id, targetId, label: "mark" }),
	name: (id: string, name: string) => ({ type: "session_info" as const, id, name }),
	custom: (id: string, customType: string, data: unknown, parent?: string | null) => ({
		type: "custom" as const,
		customType,
		data,
		id,
		...(parent === undefined ? {} : { parent }),
	}),
	compaction: (
		id: string,
		firstKeptEntryId: string | null,
		options: { coveredThroughEntryId?: string; parent?: string | null; tokens?: number } = {},
	) => ({
		type: "compaction" as const,
		id,
		...(options.parent === undefined ? {} : { parent: options.parent }),
		summary: `summary ${id}`,
		firstKeptEntryId,
		tokensBefore: 10,
		...(options.coveredThroughEntryId === undefined ? {} : { coveredThroughEntryId: options.coveredThroughEntryId }),
		details: { strategy: "verbatim-lines" },
		usage: tailUsage(options.tokens ?? 64),
	}),
};

function compactedSession(): SessionEntry[] {
	return chained([
		tailEntry.model("m1"),
		tailEntry.thinking("t1"),
		tailEntry.user("u1"),
		tailEntry.assistant("a1", 128),
		tailEntry.label("l1", "u1"),
		tailEntry.name("n1", "first"),
		tailEntry.custom("x1", "workspace_binding", { kind: "bound-workspace", worktree: "/p" }),
		tailEntry.custom("i1", "task-completion-intent", { completionId: "settled" }),
		tailEntry.custom("k1", "task-completion-ack", { completionId: "settled" }),
		tailEntry.custom("i2", "task-completion-intent", { completionId: "open" }),
		tailEntry.name("n2", "second"),
		tailEntry.user("u2"),
		tailEntry.assistant("a2", 256),
		tailEntry.compaction("c1", "u2"),
		tailEntry.user("u3"),
		tailEntry.assistant("a3", 512),
	]);
}

function usageTotals(...usages: Usage[]): SessionHistoryTotals["assistant"] {
	return usages.reduce(
		(totals, usage) => ({
			input: totals.input + usage.input,
			output: totals.output + usage.output,
			cacheRead: totals.cacheRead + usage.cacheRead,
			cacheWrite: totals.cacheWrite + usage.cacheWrite,
			cost: totals.cost + usage.cost.total,
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	);
}

async function appendEach(store: SessionStore, entries: readonly SessionEntry[], id = "session"): Promise<void> {
	await store.create(header(id), []);
	for (const [index, entry] of entries.entries()) await store.append(id, [entry], { expectSeq: index });
}

export function registerSessionStoreConformance(
	runner: SessionStoreConformanceRunner,
	name: string,
	withSubject: WithSessionStore,
): void {
	for (const reopen of [false, true]) {
		runner.describe(`${name}${reopen ? " (reopen)" : ""}`, () => {
			const check = (
				title: string,
				body: (store: SessionStore, reload: Reload) => Promise<void>,
				timeoutMs?: number,
			): void => {
				const run = () =>
					withSubject((subject) =>
						body(subject.store, async (store) => {
							if (!reopen) return store;
							await store.close();
							return subject.reopen();
						}),
					);
				if (timeoutMs === undefined) runner.it(title, run);
				else runner.it(title, run, timeoutMs);
			};

			check("creates atomically and rejects duplicate sessions without changing data", async (store, reload) => {
				const entries = [message("first", "hello")];
				assert.equal((await store.create(header(), entries)).lastSeq, 1);
				store = await reload(store);
				await assert.rejects(store.create({ ...header(), cwd: "changed" }, []), (error: Error) => {
					assert.ok(error instanceof SessionExistsError);
					assert.equal(error.sessionId, "session");
					return true;
				});
				assert.deepEqual(await store.load("session"), { header: header(), entries, lastSeq: 1 });
			});

			check("keeps U+2028 and U+2029 in entry text when the session is read back (#4957)", async (store, reload) => {
				const entries = [message("first", "a\u2028b\u2029c"), message("second", "\u2029\u2028")];
				await store.create(header(), entries.slice(0, 1));
				store = await reload(store);
				await store.append("session", entries.slice(1), { expectSeq: 1 });
				store = await reload(store);
				assert.deepEqual(await store.load("session"), { header: header(), entries, lastSeq: 2 });
			});

			check("preserves append order as the reopened leaf and allows shared entry IDs", async (store, reload) => {
				const first = message("shared", "first");
				const second = message("second", "second");
				const third = { ...message("third", "third"), parentId: "shared" };
				await store.create(header(), [first]);
				await store.create(header("other"), [first]);
				store = await reload(store);
				assert.deepEqual(await store.append("session", [second, third], { expectSeq: 1 }), { lastSeq: 3 });
				store = await reload(store);
				const snapshot = await store.load("session");
				assert.deepEqual(snapshot.entries, [first, second, third]);
				assert.equal(snapshot.entries.at(-1)?.id, "third");
				assert.equal(snapshot.lastSeq, 3);
				assert.deepEqual((await store.load("other")).entries, [first]);
			});

			check("rejects stale append and replace without partial writes", async (store, reload) => {
				await store.create(header(), [message("first", "first")]);
				store = await reload(store);
				const before = await store.load("session");
				await assert.rejects(
					store.append("session", [message("bad", "bad")], { expectSeq: 0 }),
					conflict("session", 0, 1),
				);
				await assert.rejects(
					store.replace("session", { ...header(), internal: true }, [], { expectSeq: 0 }),
					conflict("session", 0, 1),
				);
				store = await reload(store);
				assert.deepEqual(await store.load("session"), before);
			});

			check(
				"round-trips long Unicode IDs on create and append without changing the links (#5554)",
				async (store, reload) => {
					const id = "漢".repeat(1500);
					const first = message(id + "a", "first");
					const next = { ...message(id + "b", "next"), parentId: first.id };
					await store.create(header(id), [first]);
					await store.append(id, [next], { expectSeq: 1 });
					store = await reload(store);
					assert.equal((await store.readHeader(id))?.id, id);
					assert.deepEqual((await store.readRange!(id, 1, 2)).entries, [first, next]);
				},
			);

			check("admits only one of two writers using the same sequence", async (store, reload) => {
				await store.create(header(), []);
				const attempts = await Promise.allSettled([
					store.append("session", [message("a", "a")], { expectSeq: 0 }),
					store.append("session", [message("b", "b")], { expectSeq: 0 }),
				]);
				assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
				const rejected = attempts.find((result) => result.status === "rejected");
				assert.ok(rejected?.status === "rejected");
				assert.ok(rejected.reason instanceof SessionConflictError);
				conflict("session", 0, 1)(rejected.reason);
				store = await reload(store);
				assert.equal((await store.load("session")).lastSeq, 1);
			});

			check(
				"commits each of the appends made together at its own sequence, or rejects it (#6560)",
				async (store, reload) => {
					const first = message("first", "first");
					await store.create(header(), [first]);
					store = await reload(store);
					const made = [1, 2, 1, 3, 4].map((expectSeq, index) => ({
						entries: [message(`together-${index}`, `together ${index}`)],
						expectSeq,
					}));
					made.push({
						entries: [message("pair-a", "pair a"), message("pair-b", "pair b")],
						expectSeq: 5,
					});
					const attempts = await Promise.allSettled(
						made.map(({ entries, expectSeq }) => store.append("session", entries, { expectSeq })),
					);
					const committed = new Map<number, SessionEntry[]>();
					for (const [index, attempt] of attempts.entries()) {
						const { entries, expectSeq } = made[index]!;
						if (attempt.status === "rejected") {
							assert.ok(attempt.reason instanceof SessionConflictError, String(attempt.reason));
							assert.equal(attempt.reason.expectedSeq, expectSeq);
							continue;
						}
						assert.equal(attempt.value.lastSeq, expectSeq + entries.length);
						committed.set(expectSeq, entries);
					}
					// Two of them expect sequence 1: at most one commits there, so the counts differ when both did.
					assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, committed.size);
					assert.ok(committed.size <= 5);
					store = await reload(store);
					const expected = [first];
					while (committed.has(expected.length)) expected.push(...committed.get(expected.length)!);
					assert.equal(
						expected.length - 1,
						[...committed.values()].flat().length,
						"every commit continues the last",
					);
					assert.deepEqual(await store.load("session"), {
						header: header(),
						entries: expected,
						lastSeq: expected.length,
					});
				},
			);

			check(
				"a header-only change preserves every entry and fences earlier writers (#5554)",
				async (store, reload) => {
					const entries = [message("first", "一\u2028\u2029"), message("last", "e\u0301")];
					const original = await store.create(header(), entries);
					store = await reload(store);
					const updated = {
						...header(),
						internal: true,
						workflow: { runId: "run", stageId: "stage", stageName: "Stage" },
					} as const;
					const options = { expectSeq: 2, ...(original.epoch === undefined ? {} : { epoch: original.epoch }) };
					const result = await (await import("./snapshot-history.js")).updateStoredHeader(store, updated, options);
					assert.equal(result.lastSeq, 2);
					if (result.epoch !== undefined && original.epoch !== undefined) {
						assert.notEqual(result.epoch, original.epoch);
						await assert.rejects(
							store.append("session", [message("stale", "no")], { expectSeq: 2, epoch: original.epoch }),
							conflict("session", 2, 2),
						);
					}
					store = await reload(store);
					assert.deepEqual((await store.load("session")).entries, entries);
					assert.deepEqual(await store.readHeader("session"), updated);
				},
			);

			check(
				"streams exact bytes of an oversized historical entry and rejects its reference after replacement (#5554)",
				async (store, reload) => {
					const entry = message("u", "abc漢😀\u0301".repeat(Math.ceil(SESSION_HISTORY_PAGE_BYTES / 10)));
					const bytes = Buffer.from(JSON.stringify(entry));
					assert.ok(bytes.length > SESSION_HISTORY_PAGE_BYTES);
					const created = await store.create(header(), [entry]);
					store = await reload(store);
					const first = await readSessionHistory(store, "session").next();
					const ref = !first.done && first.value.items[0];
					assert.ok(ref && "kind" in ref && ref.kind === "oversized");
					assert.equal(ref.bytes, bytes.length);
					assert.equal(ref.seq, 1);
					const digest = createHash("sha256");
					for await (const part of readSessionHistoryChunks(store, ref)) {
						assert.ok(part.byteLength > 0 && part.byteLength <= SESSION_HISTORY_CHUNK_BYTES);
						digest.update(part);
					}
					assert.equal(digest.digest("hex"), createHash("sha256").update(bytes).digest("hex"));
					await store.replace("session", header(), [message("other", "replacement")], {
						expectSeq: 1,
						...(created.epoch === undefined ? {} : { epoch: created.epoch }),
					});
					await assert.rejects(
						readSessionHistoryChunks(store, ref, { offset: 1 }).next(),
						conflict("session", 1, 1),
					);
					if (store.readEntrySizes && store.readEntryChunk && store.readRange && created.epoch !== undefined)
						await assert.rejects(store.readRange("session", 1, 1, created.epoch), conflict("session", 1, 1));
				},
			);

			check(
				"reads a scan's pages, one read each, as the same entries as the default pages and rejects another generation (#5571)",
				async (store, reload) => {
					// 300 entries of 2-12 KiB around one larger than a page: some pages of a page's bytes, cut by bytes.
					const entries = Array.from({ length: 301 }, (_, i) =>
						i === 150
							? message("big", "é".repeat(SESSION_HISTORY_PAGE_BYTES / 2 + 7))
							: toolUse(i, message(`e${i}`, `${i} ${"漢x".repeat(700 + ((i * 997) % 3500))}`)),
					);
					const created = await store.create(header(), entries);
					store = await reload(store);
					const read = async (pageEntries?: number) => {
						const pages: SessionHistoryItem[][] = [];
						for await (const page of readSessionHistory(store, "session", pageEntries ? { pageEntries } : {}))
							pages.push([...page.items]);
						return pages;
					};
					const pages = await read();
					const scanned = await read(SESSION_HISTORY_SCAN_ENTRIES);
					assert.deepEqual(scanned.flat(), pages.flat());
					assert.deepEqual(
						scanned.flat().map((item) => ("entry" in item ? item.entry : item.seq)),
						entries.map((entry, i) => (i === 150 ? 151 : entry)),
					);
					const bytes = (item: SessionHistoryItem) =>
						"entry" in item ? Buffer.byteLength(JSON.stringify(item.entry)) : item.bytes;
					for (const page of scanned)
						assert.ok(
							page.length === 1 ||
								page.reduce((sum, item) => sum + bytes(item), 0) <= SESSION_HISTORY_PAGE_BYTES,
						);
					// A store that sizes its pages reads a scan in fewer of them; one that only loads its snapshot pages it alike.
					if (store.readEntrySizes && store.readRange) assert.ok(scanned.length < pages.length);
					if (!store.readScanPage || !store.readEntrySizes) return;
					const { epoch } = await store.readEntrySizes("session", 1, 0);
					// No entry for an empty range, only the session's head; without a generation, the current one.
					const head = { header: header(), epoch, lastSeq: 301 };
					assert.deepEqual(await store.readScanPage("session", 1, 0, epoch, 1), {
						...head,
						throughSeq: 0,
						items: [],
					});
					assert.deepEqual(await store.readScanPage("session", 1, 0, undefined, 1), {
						...head,
						throughSeq: 0,
						items: [],
					});
					const limited = await store.readScanPage("session", 3, 301, epoch, 2);
					assert.deepEqual(limited, {
						...head,
						throughSeq: 4,
						items: [
							{ seq: 3, entry: entries[2] },
							{ seq: 4, entry: entries[3] },
						],
					});
					// A run stops before an entry larger than a page, which is a reference of its own.
					const before = await store.readScanPage("session", 148, 301, epoch, 10);
					assert.deepEqual(
						before.items.map((item) => item.seq),
						[148, 149, 150],
					);
					assert.equal(before.throughSeq, 150);
					const big = {
						kind: "oversized",
						sessionId: "session",
						epoch,
						seq: 151,
						bytes: bytes(scanned.flat()[150]!),
					};
					assert.deepEqual(await store.readScanPage("session", 151, 301, epoch, 10), {
						...head,
						throughSeq: 151,
						items: [big],
					});
					// Only tool results, assistant messages calling a tool other than `exceptCalls`, and entries larger than
					// a page, possibly with more; each page says how far it accounts for the range.
					const select = { exceptCalls: ["bash"] };
					const selected: SessionScanPage[] = [];
					for (let from = 1; from <= 301; from = selected.at(-1)!.throughSeq + 1)
						selected.push(
							await store.readScanPage("session", from, 301, epoch, SESSION_HISTORY_SCAN_ENTRIES, { select }),
						);
					const seqs = selected.flatMap((page) => page.items.map((item) => item.seq));
					for (const seq of [10, 20, 151, 200]) assert.ok(seqs.includes(seq), `selects ${seq}: ${seqs}`);
					for (const seq of seqs) assert.ok([10, 20, 30, 151, 200].includes(seq), `selects no ${seq}`);
					assert.deepEqual(
						selected.flatMap((page) => page.items).filter((item) => item.seq !== 151),
						seqs.filter((seq) => seq !== 151).map((seq) => ({ seq, entry: entries[seq - 1] })),
					);
					assert.ok(
						selected.every((page) => page.lastSeq === 301 && page.items.length <= SESSION_HISTORY_SCAN_ENTRIES),
					);
					assert.equal(selected.at(-1)!.throughSeq, 301);
					assert.ok(selected.length <= 4, `${selected.length} selected`);
					assert.deepEqual(
						(await store.readScanPage("session", 1, 301, epoch, 1, { select })).items.map((item) => item.seq),
						[10],
					);
					// A run can end with the reference that follows it, which brings the first bytes of its JSON.
					const trailing = await store.readScanPage("session", 148, 301, epoch, 10, {
						trailingReference: true,
						referencePrefix: 16,
					});
					assert.deepEqual(
						trailing.items.map((item) => item.seq),
						[148, 149, 150, 151],
					);
					assert.deepEqual(trailing.items.at(-1), big);
					assert.equal(trailing.throughSeq, 151);
					assert.deepEqual(
						Buffer.from(trailing.prefixes?.get(151) ?? []).toString(),
						JSON.stringify(entries[150]).slice(0, 16),
					);
					const after = await store.readScanPage("session", 1, 301, epoch, SESSION_HISTORY_SCAN_ENTRIES, {
						select,
						trailingReference: true,
					});
					assert.deepEqual(
						after.items.map((item) => item.seq).filter((seq) => seq !== 30),
						[10, 20, 151],
					);
					assert.equal(bytes(scanned.flat()[150]!), Buffer.byteLength(JSON.stringify(entries[150])));
					await assert.rejects(store.readScanPage("missing", 1, 1, epoch, 1), notFound("missing"));
					await store.replace("session", header(), [message("other", "replacement")], {
						expectSeq: 301,
						...(created.epoch === undefined ? {} : { epoch: created.epoch }),
					});
					await assert.rejects(store.readScanPage("session", 1, 1, epoch, 1), SessionConflictError);
				},
				LARGE_VALUE_TIMEOUT_MS,
			);

			check("replaces header and entries including parent and workflow metadata", async (store, reload) => {
				await store.create(header(), [message("old", "old")]);
				store = await reload(store);
				const replacement: SessionRecordHeader = {
					...header(),
					internal: true,
					parentSessionId: "parent",
					workflow: { runId: "run", stageId: "stage", stageName: " Stage " },
				};
				const entries = [message("new", "new"), message("last", "last")];
				assert.equal((await store.replace("session", replacement, entries, { expectSeq: 1 })).lastSeq, 2);
				store = await reload(store);
				assert.deepEqual(await store.readHeader("session"), replacement);
				assert.deepEqual(await store.load("session"), { header: replacement, entries, lastSeq: 2 });
			});

			check("rejects replacing a session ID without changing either session (#3650)", async (store, reload) => {
				const entries = [message("saved", "saved")];
				await store.create(header(), entries);
				store = await reload(store);
				await assert.rejects(
					store.replace("session", header("replacement"), [message("new", "new")], { expectSeq: 1 }),
					(error: Error) => {
						assert.ok(error instanceof SessionIdMismatchError);
						assert.equal(error.requested, "session");
						assert.equal(error.found, "replacement");
						return true;
					},
				);
				store = await reload(store);
				assert.deepEqual(await store.load("session"), { header: header(), entries, lastSeq: 1 });
				assert.equal(await store.readHeader("replacement"), undefined);
				await assert.rejects(store.load("replacement"), notFound("replacement"));
			});

			check("filters exact projects and hides internal sessions in list and most recent", async (store, reload) => {
				await store.create(header("visible"), []);
				await store.create({ ...header("internal"), internal: true }, [
					message("recent", "hidden", Date.parse(createdAt) + 2000),
				]);
				await store.create({ ...header("elsewhere"), cwd: "/project/../project" }, []);
				store = await reload(store);
				assert.deepEqual(
					(await collect(store, { cwd: "/project" })).map((item) => item.id),
					["visible"],
				);
				assert.deepEqual((await collect(store)).map((item) => item.id).sort(), ["elsewhere", "visible"]);
				assert.equal((await collect(store, { cwd: "/project", includeInternal: true })).length, 2);
				assert.equal((await store.findMostRecent({ cwd: "/project" }))?.id, "visible");
				assert.equal((await store.findMostRecent({ cwd: "/project", includeInternal: true }))?.id, "internal");
				assert.equal(await store.findMostRecent({ cwd: "missing" }), undefined);
			});

			check("lists only sessions whose id starts with an id prefix, ignoring case", async (store, reload) => {
				await store.create(header("0a1b2c3d-0000-4000-8000-000000000001"), []);
				await store.create({ ...header("0A1B2C3D-0000-4000-8000-000000000002"), internal: true }, []);
				await store.create({ ...header("0a1b2c3e-0000-4000-8000-000000000003"), cwd: "/elsewhere" }, []);
				store = await reload(store);
				assert.deepEqual(
					(await collect(store, { idPrefix: "0A1B2C3D", includeInternal: true })).map((item) => item.id).sort(),
					["0A1B2C3D-0000-4000-8000-000000000002", "0a1b2c3d-0000-4000-8000-000000000001"],
				);
				assert.deepEqual((await collect(store, { idPrefix: "0a1b2c3" })).map((item) => item.id).sort(), [
					"0a1b2c3d-0000-4000-8000-000000000001",
					"0a1b2c3e-0000-4000-8000-000000000003",
				]);
				assert.deepEqual(await collect(store, { idPrefix: "ffffffff", includeInternal: true }), []);
			});

			check(
				"computes summaries from messages and the latest metadata without rewriting text",
				async (store, reload) => {
					const time = Date.parse(createdAt) + 1000;
					const entries: SessionEntry[] = [
						message("first", " hello\u0000\ud800 ", time),
						{ type: "session_info", id: "name", parentId: null, timestamp: createdAt, name: " Name " },
						{
							type: "session_summary",
							id: "summary",
							parentId: null,
							timestamp: createdAt,
							summary: " Summary ",
							summarizedThroughId: "first",
						},
						{
							type: "message",
							id: "tool",
							parentId: null,
							timestamp: "2099-01-01T00:00:00Z",
							message: {
								role: "toolResult",
								toolCallId: "call",
								toolName: "test",
								content: [{ type: "text", text: "ignored" }],
								isError: false,
								timestamp: time + 1000,
							},
						},
					];
					await store.create({ ...header(), parentSessionId: "parent" }, entries);
					store = await reload(store);
					const [summary] = await collect(store);
					assert.ok(summary);
					assert.equal(summary.id, "session");
					assert.equal(summary.cwd, "/project");
					assert.equal(summary.parentSessionId, "parent");
					assert.equal(summary.internal, false);
					assert.equal(summary.createdAt, createdAt);
					assert.equal(summary.modifiedAt, new Date(time).toISOString());
					assert.equal(summary.messageCount, 2);
					assert.equal(summary.firstMessage, " hello\u0000\ud800 ");
					assert.equal(summary.searchText, " hello\u0000\ud800 ");
					assert.equal(summary.name, " Name ");
					assert.equal(summary.hasName, true);
					assert.equal(summary.summary, " Summary ");
					assert.equal(summary.summarizedThroughId, "first");
					await store.append(
						"session",
						[
							{ type: "session_info", id: "clear", parentId: null, timestamp: createdAt, name: "" },
							{
								type: "session_summary",
								id: "latest",
								parentId: null,
								timestamp: createdAt,
								summary: "",
								summarizedThroughId: "tool",
							},
						],
						{ expectSeq: 4 },
					);
					store = await reload(store);
					const [cleared] = await collect(store);
					assert.equal(cleared?.name, "");
					assert.equal(cleared?.hasName, true);
					assert.equal(cleared?.summary, "");
					assert.equal(cleared?.summarizedThroughId, "tool");
				},
			);

			check("uses user and assistant text and activity rather than append timestamps", async (store, reload) => {
				const time = Date.parse(createdAt) + 1000;
				const assistant: SessionEntry = {
					type: "message",
					id: "assistant",
					parentId: null,
					timestamp: createdAt,
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "hidden" },
							{ type: "text", text: "answer" },
						],
						api: "openai-responses",
						provider: "openai",
						model: "test",
						stopReason: "stop",
						timestamp: time,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				};
				await store.create(header(), [assistant, message("earlier", "question")]);
				store = await reload(store);
				const [summary] = await collect(store);
				assert.equal(summary?.modifiedAt, new Date(time).toISOString());
				assert.equal(summary?.messageCount, 2);
				assert.equal(summary?.firstMessage, "question");
				assert.equal(summary?.searchText, "answer question");
			});

			for (const timestamp of [-8640000000000001, 8640000000000001]) {
				check(`rejects out-of-range message timestamp ${timestamp} atomically`, async (store, reload) => {
					const entry: SessionEntry = {
						type: "message",
						id: "invalid",
						parentId: null,
						timestamp: createdAt,
						message: { role: "user", content: "invalid time", timestamp },
					};
					const invalid = (error: Error): boolean => {
						assert.ok(error instanceof SessionInvalidTimestampError);
						assert.equal(error.field, "entry.message.timestamp");
						assert.equal(error.value, timestamp);
						assert.equal(error.reason, "out-of-range");
						return true;
					};
					await assert.rejects(store.create(header("rejected"), [message("valid", "valid"), entry]), invalid);
					assert.equal(await store.readHeader("rejected"), undefined);
					const entries = [message("original", "original")];
					await store.create(header(), entries);
					await assert.rejects(
						store.append("session", [message("valid", "valid"), entry], { expectSeq: 1 }),
						invalid,
					);
					await assert.rejects(store.replace("session", header(), [entry], { expectSeq: 1 }), invalid);
					store = await reload(store);
					assert.deepEqual(await store.load("session"), { header: header(), entries, lastSeq: 1 });
					assert.equal(await store.readHeader("rejected"), undefined);
					assert.equal((await collect(store)).length, 1);
					assert.equal((await store.findMostRecent({ cwd: "/project" }))?.id, "session");
				});
			}

			for (const field of ["header.createdAt", "entry.timestamp"] as const) {
				check(`rejects invalid ${field} strings without partial writes`, async (store, reload) => {
					const entries = [message("original", "original")];
					await store.create(header(), entries);
					for (const [value, reason] of [
						["not a timestamp", "unparseable"],
						["2026-10-15", "unparseable"],
						["2026-10-15T00:00:00", "unparseable"],
						["Thu, 15 Oct 2026 00:00:00 GMT", "unparseable"],
						["2026-10-15T00:00:00.1234567890Z", "unparseable"],
						["+02026-10-15T00:00:00Z", "unparseable"],
						["2026-13-01T00:00Z", "unparseable"],
						["2026-10-15T25:00Z", "unparseable"],
						["2026-10-15T00:00+24:00", "unparseable"],
						["-000000-01-01T00:00Z", "unparseable"],
						["2026-13-15T00:00Z", "unparseable"],
						["2026-13-15T00:00:00Z", "unparseable"],
						["2026-10-15T25:00:00Z", "unparseable"],
						["2026-99-15T12:00Z", "unparseable"],
						["2026-10-15T00:00+99:00", "unparseable"],
						["-000000-10-15T00:00:00Z", "unparseable"],
						["+275761-01-01T00:00Z", "out-of-range"],
						["-271822-01-01T00:00Z", "out-of-range"],
						["+275761-13-01T00:00Z", "unparseable"],
						["+275761-01-01T00:00+24:00", "unparseable"],
						["+275760-09-13T00:00:00.001Z", "out-of-range"],
						["-271821-04-19T23:59:59.999Z", "out-of-range"],
					] as const) {
						const invalid = (error: Error): boolean => {
							assert.ok(error instanceof SessionInvalidTimestampError);
							assert.equal(error.field, field);
							assert.equal(error.value, value);
							assert.equal(error.reason, reason);
							return true;
						};
						const invalidHeader =
							field === "header.createdAt" ? { ...header("rejected"), createdAt: value } : header("rejected");
						const invalidEntries: SessionEntry[] =
							field === "entry.timestamp"
								? [{ type: "session_info", id: "invalid", parentId: null, timestamp: value, name: "name" }]
								: entries;
						await assert.rejects(store.create(invalidHeader, invalidEntries), invalid);
						if (field === "entry.timestamp") {
							await assert.rejects(
								store.append("session", [...entries, ...invalidEntries], { expectSeq: 1 }),
								invalid,
							);
						}
						await assert.rejects(
							store.replace("session", invalidHeader, invalidEntries, { expectSeq: 1 }),
							invalid,
						);
						store = await reload(store);
						assert.equal(await store.readHeader("rejected"), undefined);
						assert.deepEqual(await store.load("session"), { header: header(), entries, lastSeq: 1 });
						assert.equal((await collect(store)).length, 1);
						assert.equal((await store.findMostRecent({ cwd: "/project" }))?.id, "session");
					}
				});
			}

			for (const field of ["entry.message.timestamp", "entry.systemMessage.timestamp"] as const) {
				check(`rejects invalid ${field} numbers without partial writes`, async (store, reload) => {
					const entries = [message("original", "original")];
					await store.create(header(), entries);
					for (const timestamp of [NaN, -Infinity, Infinity, -8640000000000001, 8640000000000001]) {
						const entry: SessionEntry =
							field === "entry.message.timestamp"
								? {
										type: "message",
										id: "invalid",
										parentId: null,
										timestamp: createdAt,
										message: {
											role: "toolResult",
											toolCallId: "call",
											toolName: "test",
											content: [],
											isError: false,
											timestamp,
										},
									}
								: {
										type: "compaction",
										id: "invalid",
										parentId: null,
										timestamp: createdAt,
										summary: "summary",
										firstKeptEntryId: null,
										tokensBefore: 0,
										systemMessage: { role: "system", content: "system", timestamp },
									};
						const invalid = (error: Error): boolean => {
							assert.ok(error instanceof SessionInvalidTimestampError);
							assert.equal(error.field, field);
							assert.equal(error.value, timestamp);
							assert.equal(error.reason, "out-of-range");
							return true;
						};
						await assert.rejects(store.create(header("rejected"), [entry]), invalid);
						await assert.rejects(store.append("session", [...entries, entry], { expectSeq: 1 }), invalid);
						await assert.rejects(store.replace("session", header(), [entry], { expectSeq: 1 }), invalid);
						store = await reload(store);
						assert.equal(await store.readHeader("rejected"), undefined);
						assert.deepEqual(await store.load("session"), { header: header(), entries, lastSeq: 1 });
						assert.equal((await collect(store)).length, 1);
						assert.equal((await store.findMostRecent({ cwd: "/project" }))?.id, "session");
					}
				});
			}

			check(
				"preserves both Date boundaries and orders valid activity instead of append or creation time",
				async (store, reload) => {
					const minimum = -8640000000000000;
					const maximum = 8640000000000000;
					const earliestHeader = { ...header("earliest"), createdAt: "+275760-09-13T00:00:00.000Z" };
					const latestHeader = { ...header("latest"), createdAt: "-271821-04-20T00:00:00.000Z" };
					const earliestEntries = [message("first", "first", minimum)];
					const latestEntries = [
						message("zero", "question", 0),
						message("maximum", "latest", maximum),
						message("minimum", "older", minimum),
					];
					await store.create(earliestHeader, earliestEntries);
					await store.create(latestHeader, latestEntries);
					await store.create(header("fallback"), []);
					store = await reload(store);
					assert.deepEqual(await store.load("earliest"), {
						header: earliestHeader,
						entries: earliestEntries,
						lastSeq: 1,
					});
					assert.deepEqual(await store.load("latest"), {
						header: latestHeader,
						entries: latestEntries,
						lastSeq: 3,
					});
					const summaries = await collect(store);
					assert.equal(summaries.length, 3);
					assert.equal(
						summaries.find((item) => item.id === "earliest")?.modifiedAt,
						new Date(minimum).toISOString(),
					);
					const latest = summaries.find((item) => item.id === "latest");
					assert.equal(latest?.modifiedAt, new Date(maximum).toISOString());
					assert.equal(latest?.messageCount, 3);
					assert.equal(latest?.firstMessage, "question");
					assert.equal(latest?.searchText, "question latest older");
					assert.equal(summaries.find((item) => item.id === "fallback")?.modifiedAt, createdAt);
					assert.equal((await store.findMostRecent({ cwd: "/project" }))?.id, "latest");
				},
			);

			check(
				"preserves accepted ISO instants verbatim and compares their represented times",
				async (store, reload) => {
					const timestamps = [
						"2026-10-15T01:00+01:00",
						"2026-10-15T01:00:00.123456789+01:00",
						"+002026-10-15T00:00:00.123Z",
						"2026-10-15T02:00:00-01:00",
						"2026-02-30T00:00:00Z",
					];
					for (const [index, timestamp] of timestamps.entries()) {
						const storedHeader = { ...header(String(index)), createdAt: timestamp };
						const entry: SessionEntry = {
							type: "custom",
							id: "entry",
							parentId: null,
							timestamp,
							customType: "data",
							data: { timestamp: "not a date\u0000\ud800" },
						};
						await store.create(storedHeader, [entry]);
						store = await reload(store);
						assert.deepEqual(await store.load(storedHeader.id), {
							header: storedHeader,
							entries: [entry],
							lastSeq: 1,
						});
					}
					const summaries = await collect(store);
					for (const [index, timestamp] of timestamps.entries()) {
						assert.equal(summaries.find((item) => item.id === String(index))?.modifiedAt, timestamp);
					}
					assert.equal((await store.findMostRecent({ cwd: "/project" }))?.id, "3");
				},
			);

			check(
				"keeps compaction system messages optional and preserves valid timestamp boundaries",
				async (store, reload) => {
					const compaction: SessionEntry = {
						type: "compaction",
						id: "omitted",
						parentId: null,
						timestamp: createdAt,
						summary: "summary",
						firstKeptEntryId: null,
						tokensBefore: 0,
					};
					const entries: SessionEntry[] = [
						compaction,
						...[-8640000000000000, 8640000000000000].map((timestamp) => ({
							...compaction,
							id: String(timestamp),
							systemMessage: { role: "system" as const, content: "system", timestamp },
						})),
					];
					await store.create(header(), entries);
					store = await reload(store);
					assert.deepEqual(await store.load("session"), { header: header(), entries, lastSeq: 3 });
					const [summary] = await collect(store);
					assert.equal(summary?.modifiedAt, createdAt);
					assert.equal(summary?.messageCount, 0);
					assert.equal((await store.findMostRecent({ cwd: "/project" }))?.id, "session");
				},
			);

			check("preserves empty values, duplicate entries and absent optional fields", async (store, reload) => {
				const emptyHeader = { ...header(""), cwd: "", createdAt: "2026-10-15T01:00+01:00" };
				assert.equal((await store.create(emptyHeader, [])).lastSeq, 0);
				assert.deepEqual(await store.append("", [], { expectSeq: 0 }), { lastSeq: 0 });
				store = await reload(store);
				const [summary] = await collect(store, { cwd: "" });
				assert.ok(summary);
				assert.equal(summary.modifiedAt, emptyHeader.createdAt);
				assert.equal(summary.hasName, false);
				assert.equal(summary.messageCount, 0);
				assert.equal(summary.firstMessage, "(no messages)");
				assert.equal(summary.searchText, "");
				for (const key of ["parentSessionId", "workflow", "name", "summary", "summarizedThroughId"])
					assert.equal(Object.hasOwn(summary, key), false);
				const entry = message("", "");
				await store.append("", [entry, entry], { expectSeq: 0 });
				store = await reload(store);
				assert.deepEqual((await store.load("")).entries, [entry, entry]);
				assert.equal((await store.replace("", emptyHeader, [], { expectSeq: 2 })).lastSeq, 0);
			});

			check("rejects invalid structural text atomically with NUL precedence", async (store, reload) => {
				for (const value of ["bad\u0000text", "bad\ud800text", "\ud800\u0000"]) {
					const reason = value.includes("\u0000") ? "nul-character" : "ill-formed-unicode";
					const headers: { field: SessionTextField; value: SessionRecordHeader }[] = [
						{ field: "header.id", value: { ...header(), id: value } },
						{ field: "header.cwd", value: { ...header(), cwd: value } },
						{ field: "header.parentSessionId", value: { ...header(), parentSessionId: value } },
					];
					for (const invalid of headers) {
						await assert.rejects(store.create(invalid.value, []), invalidText(invalid.field, reason));
						assert.deepEqual(await collect(store), []);
					}
				}
				await store.create(header(), []);
				for (const value of ["bad\u0000text", "bad\ud800text", "\ud800\u0000"]) {
					const reason = value.includes("\u0000") ? "nul-character" : "ill-formed-unicode";
					const entries: { field: SessionTextField; value: SessionEntry }[] = [
						{ field: "entry.id", value: { ...message("entry", "body"), id: value } },
						{ field: "entry.parentId", value: { ...message("entry", "body"), parentId: value } },
						{
							field: "summarizedThroughId",
							value: {
								type: "session_summary",
								id: "entry",
								parentId: null,
								timestamp: createdAt,
								summary: "body",
								summarizedThroughId: value,
							},
						},
					];
					for (const invalid of entries) {
						await assert.rejects(
							store.create(header("other"), [invalid.value]),
							invalidText(invalid.field, reason),
						);
						await assert.rejects(
							store.append("session", [message("good", "body"), invalid.value], { expectSeq: 0 }),
							invalidText(invalid.field, reason),
						);
						await assert.rejects(
							store.replace("session", header(), [invalid.value], { expectSeq: 0 }),
							invalidText(invalid.field, reason),
						);
					}
					await assert.rejects(
						store.replace("session", { ...header(), cwd: value }, [], { expectSeq: 0 }),
						invalidText("header.cwd", reason),
					);
				}
				store = await reload(store);
				assert.deepEqual(await store.load("session"), { header: header(), entries: [], lastSeq: 0 });
				assert.equal(await store.readHeader("other"), undefined);
			});

			check("rejects invalid sessionId arguments without deleting or changing records", async (store, reload) => {
				await store.create(header(), []);
				for (const value of ["bad\u0000text", "bad\ud800text", "\ud800\u0000"]) {
					const reason = value.includes("\u0000") ? "nul-character" : "ill-formed-unicode";
					await assert.rejects(store.load(value), invalidText("sessionId", reason));
					await assert.rejects(store.readHeader(value), invalidText("sessionId", reason));
					await assert.rejects(store.delete(value), invalidText("sessionId", reason));
					await assert.rejects(store.append(value, [], { expectSeq: 0 }), invalidText("sessionId", reason));
					await assert.rejects(
						store.replace(value, header(), [], { expectSeq: 0 }),
						invalidText("sessionId", reason),
					);
					if (store.putBlob !== undefined && store.getBlob !== undefined) {
						await assert.rejects(store.putBlob(value, new Uint8Array([1])), invalidText("sessionId", reason));
						await assert.rejects(store.getBlob(value, "0".repeat(64)), invalidText("sessionId", reason));
					}
				}
				store = await reload(store);
				assert.deepEqual(await store.load("session"), { header: header(), entries: [], lastSeq: 0 });
			});

			check("preserves NUL and lone surrogates in returned user text", async (store, reload) => {
				const text = " before\u0000\ud800after ";
				const storedHeader = {
					...header(),
					createdAt,
					workflow: { runId: text, stageId: text, stageName: text },
				};
				const entries: SessionEntry[] = [
					{ type: "session_info", id: "name", parentId: null, timestamp: createdAt, name: text },
					{
						type: "session_summary",
						id: "summary",
						parentId: null,
						timestamp: createdAt,
						summary: text,
						summarizedThroughId: "name",
					},
				];
				await store.create(storedHeader, entries);
				store = await reload(store);
				assert.deepEqual(await store.load("session"), { header: storedHeader, entries, lastSeq: 2 });
				const [summary] = await collect(store);
				assert.equal(summary?.name, text);
				assert.equal(summary?.summary, text);
				assert.equal(summary?.createdAt, createdAt);
				assert.equal(summary?.modifiedAt, createdAt);
				assert.deepEqual(summary?.workflow, storedHeader.workflow);
			});

			check(
				"keeps each session's blobs by content hash until the session is deleted (#4379)",
				async (store, reload) => {
					if (store.putBlob === undefined || store.getBlob === undefined) return;
					const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
					const hash = createHash("sha256").update(bytes).digest("hex");
					await assert.rejects(store.putBlob("session", bytes), notFound("session"));
					await store.create(header(), [message("first", "first")]);
					await store.create(header("other"), []);
					const input = Uint8Array.from(bytes);
					assert.deepEqual(await store.putBlob("session", input), { hash, bytes: 256 });
					input.fill(0);
					assert.deepEqual(await store.putBlob("session", bytes), { hash, bytes: 256 });
					const empty = await store.putBlob("session", new Uint8Array());
					assert.deepEqual(empty, { hash: createHash("sha256").digest("hex"), bytes: 0 });
					store = await reload(store);
					const read = await store.getBlob!("session", hash);
					assert.deepEqual(read, bytes);
					read!.fill(1);
					assert.deepEqual(await store.getBlob!("session", hash), bytes);
					assert.deepEqual(await store.getBlob!("session", empty.hash), new Uint8Array());
					assert.equal(await store.getBlob!("session", "0".repeat(64)), undefined);
					assert.equal(await store.getBlob!("other", hash), undefined, "another session does not hold it");
					assert.equal(await store.getBlob!("missing", hash), undefined);
					await store.replace("session", header(), [message("replaced", "replaced")], { expectSeq: 1 });
					await store.append("session", [message("next", "next")], { expectSeq: 1 });
					assert.deepEqual(await store.getBlob!("session", hash), bytes, "writing entries keeps the blobs");
					assert.deepEqual(
						(await store.load("session")).entries.map((entry) => entry.id),
						["replaced", "next"],
						"blobs are not entries",
					);
					await store.delete("session");
					store = await reload(store);
					assert.equal(await store.getBlob!("session", hash), undefined);
					await store.create(header(), []);
					assert.equal(await store.getBlob!("session", hash), undefined, "a session created again holds none");
					await assert.rejects(store.putBlob!("missing", bytes), notFound("missing"));
				},
			);

			check(
				"returns blobs of every size around a megabyte intact, each stored once (#4379)",
				async (store, reload) => {
					if (store.putBlob === undefined || store.getBlob === undefined) return;
					const MiB = 1024 * 1024;
					await store.create(header(), []);
					const stored = new Map<number, { readonly hash: string; readonly bytes: Uint8Array }>();
					for (const size of [1, MiB - 1, MiB, MiB + 1, 2 * MiB, 2.5 * MiB]) {
						const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 31 + size) % 251);
						const blob = await store.putBlob("session", bytes);
						assert.deepEqual(blob, { hash: createHash("sha256").update(bytes).digest("hex"), bytes: size });
						assert.deepEqual(await store.putBlob("session", bytes), blob, `storing ${size} bytes again`);
						stored.set(size, { hash: blob.hash, bytes });
					}
					store = await reload(store);
					for (const [size, { hash, bytes }] of stored) {
						const read = await store.getBlob!("session", hash);
						assert.equal(read?.byteLength, size);
						assert.ok(Buffer.from(read!).equals(Buffer.from(bytes)), `${size} bytes read back as stored`);
					}
					await store.delete("session");
					for (const { hash } of stored.values()) assert.equal(await store.getBlob!("session", hash), undefined);
				},
			);

			check(
				"stores a 10 MB entry and a session of more than 10 MB, loads them whole and lists them (#4954)",
				async (store, reload) => {
					const MB = 1_000_000;
					// Multi-byte and astral characters land on chunk boundaries; the text is longer than any listing keeps.
					const text = Array.from({ length: MB }, (_, index) => `line${index % 10} é😀\n`).join("");
					const large = message("large", text);
					await store.create(header(), [large]);
					const replies: SessionEntry[] = Array.from({ length: 12 }, (_, index) => ({
						...message(`reply-${index}`, `${index}`.repeat(MB)),
						parentId: index === 0 ? "large" : `reply-${index - 1}`,
					}));
					for (const [index, reply] of replies.entries()) {
						await store.append("session", [reply], { expectSeq: index + 1 });
					}
					store = await reload(store);
					const loaded = await store.load("session");
					assert.equal(loaded.lastSeq, 13);
					assert.equal(loaded.entries.length, 13);
					assert.ok(
						JSON.stringify(loaded.entries) === JSON.stringify([large, ...replies]),
						"every entry loads back exactly, in order",
					);
					const [summary] = await collect(store);
					assert.equal(summary?.messageCount, 13);
					assert.equal(summary?.firstMessage, text.slice(0, SESSION_SUMMARY_TEXT_CHARS));
					assert.ok(summary?.searchText.startsWith(text.slice(0, SESSION_SUMMARY_TEXT_CHARS)));
					assert.ok(summary?.searchText.endsWith("1".repeat(SESSION_SUMMARY_TEXT_CHARS)));
					const small = message("small", "small");
					await store.replace("session", header(), [small], { expectSeq: 13 });
					store = await reload(store);
					assert.deepEqual((await store.load("session")).entries, [small]);
					await store.delete("session");
					await assert.rejects(store.load("session"), notFound("session"));
				},
				LARGE_VALUE_TIMEOUT_MS,
			);

			check("rejects blob reads and writes after close (#4379)", async (store) => {
				if (store.putBlob === undefined || store.getBlob === undefined) return;
				await store.create(header(), []);
				await store.close();
				await assert.rejects(store.putBlob("session", new Uint8Array([1])), StoreClosedError);
				await assert.rejects(store.getBlob("session", "0".repeat(64)), StoreClosedError);
			});

			check("round-trips NUL characters in JSON entry bodies", async (store, reload) => {
				const entry: SessionEntry = {
					type: "custom",
					id: "entry",
					parentId: null,
					timestamp: createdAt,
					customType: "payload",
					data: { text: "before\u0000after", nested: ["\u0000", { value: "\ud800" }] },
				};
				await store.create(header(), [entry]);
				store = await reload(store);
				assert.deepEqual((await store.load("session")).entries, [entry]);
			});

			check(
				"preserves cancellation reasons before, between and after listing yields (#4319)",
				async (store, reload) => {
					await store.create(header("one"), []);
					await store.create(header("two"), []);
					store = await reload(store);
					const isReason = (reason: unknown) => (error: unknown) => {
						assert.equal(error, reason);
						return true;
					};
					for (const reason of [undefined, new Error("custom reason"), "custom reason"]) {
						const before = new AbortController();
						before.abort(reason);
						const aborted = store.list({ signal: before.signal })[Symbol.asyncIterator]();
						await assert.rejects(aborted.next(), isReason(before.signal.reason));
						const between = new AbortController();
						const iterator = store.list({ signal: between.signal })[Symbol.asyncIterator]();
						assert.equal((await iterator.next()).done, false);
						between.abort(reason);
						await assert.rejects(iterator.next(), isReason(between.signal.reason));
						assert.equal((await iterator.next()).done, true);
						const last = new AbortController();
						const drained = store.list({ signal: last.signal })[Symbol.asyncIterator]();
						assert.equal((await drained.next()).done, false);
						assert.equal((await drained.next()).done, false);
						last.abort(reason);
						await assert.rejects(drained.next(), isReason(last.signal.reason));
						assert.equal((await drained.next()).done, true);
					}
				},
			);

			check("deletes and recreates sessions and reports missing reads and writes", async (store, reload) => {
				await assert.rejects(store.load("missing"), notFound("missing"));
				assert.equal(await store.readHeader("missing"), undefined);
				await assert.rejects(store.append("missing", [], { expectSeq: 0 }), notFound("missing"));
				await assert.rejects(
					store.replace("missing", header("missing"), [], { expectSeq: 0 }),
					notFound("missing"),
				);
				await store.delete("missing");
				await store.create(header(), [message("first", "first")]);
				await store.delete("session");
				store = await reload(store);
				await assert.rejects(store.load("session"), notFound("session"));
				assert.equal(await store.readHeader("session"), undefined);
				assert.deepEqual(await collect(store), []);
				assert.equal((await store.create(header(), [])).lastSeq, 0);
			});

			check("detaches input and returned records, headers and summaries", async (store, reload) => {
				const original = { ...header(), workflow: { runId: "run", stageId: "stage", stageName: "original" } };
				const entries = [message("first", "original")];
				await store.create(original, entries);
				original.workflow.stageName = "mutated";
				entries[0]!.id = "mutated";
				store = await reload(store);
				const snapshot = await store.load("session");
				assert.equal(snapshot.header.workflow?.stageName, "original");
				assert.equal(snapshot.entries[0]?.id, "first");
				snapshot.entries[0]!.id = "changed";
				if (snapshot.header.workflow) snapshot.header.workflow.stageName = "changed";
				const read = await store.readHeader("session");
				assert.ok(read?.workflow);
				read.workflow.stageName = "changed";
				const [summary] = await collect(store);
				assert.ok(summary?.workflow);
				summary.workflow.stageName = "changed";
				const recent = await store.findMostRecent({ cwd: "/project" });
				assert.ok(recent?.workflow);
				recent.workflow.stageName = "changed";
				assert.equal((await store.load("session")).entries[0]?.id, "first");
				assert.equal((await store.readHeader("session"))?.workflow?.stageName, "original");
			});

			check(
				"keeps open-session markers every opener of the store sees, when it keeps any (#4971)",
				async (store, reload) => {
					const markers = store.openMarkers;
					if (markers === undefined) return;
					const marker = { token: "1234-abcd", pid: 1234, host: "host-a" };
					await markers.put("session", marker);
					await markers.put("session", { ...marker, token: "5678-ef01", pid: 5678, host: "host-b" });
					await markers.put("other", { ...marker, token: "9999-0000" });
					await markers.put("session", { ...marker, pid: 4321 });
					store = await reload(store);
					const reopened = store.openMarkers!;
					const sorted = async (sessionId: string) =>
						[...(await reopened.list(sessionId))].sort((a, b) => a.token.localeCompare(b.token));
					const listed = await sorted("session");
					// Each marker's age is read on the store's clock, which stamped it just now.
					for (const each of listed) assert.ok(each.ageMs >= 0 && each.ageMs < 60_000, String(each.ageMs));
					assert.deepEqual(
						listed.map(({ ageMs: _ageMs, ...rest }) => rest),
						[
							{ ...marker, pid: 4321 },
							{ ...marker, token: "5678-ef01", pid: 5678, host: "host-b" },
						],
					);
					await reopened.remove("session", "1234-abcd");
					await reopened.remove("session", "missing");
					assert.deepEqual(
						(await sorted("session")).map((each) => each.token),
						["5678-ef01"],
					);
					assert.deepEqual(
						(await sorted("other")).map((each) => each.token),
						["9999-0000"],
					);
					assert.deepEqual(await reopened.list("none"), []);
					await store.close();
					await assert.rejects(reopened.list("session"), StoreClosedError);
					await assert.rejects(reopened.put("session", marker), StoreClosedError);
					await assert.rejects(reopened.remove("session", "5678-ef01"), StoreClosedError);
				},
			);

			check("reads entry ranges with maxChars and skipTypes (#5250)", async (store, reload) => {
				assert.equal(typeof store.readEntryRange, "function");
				const custom: SessionEntry = {
					type: "custom",
					id: "c2",
					parentId: "e1",
					timestamp: createdAt,
					customType: "note",
					data: { value: "skipped" },
				};
				const entries = [message("e1", "first"), custom, message("e3", "third"), message("e4", "fourth")];
				await store.create(header(), entries);
				store = await reload(store);
				const page = await store.readEntryRange!("session", { fromSeq: 2, toSeq: 4 });
				assert.equal(page.lastSeq, 4);
				assert.equal(page.throughSeq, 4);
				assert.deepEqual(
					page.entries.map((item) => [item.seq, item.entry]),
					[
						[2, custom],
						[3, entries[2]],
						[4, entries[3]],
					],
				);
				const filtered = await store.readEntryRange!("session", {
					fromSeq: 1,
					toSeq: 4,
					skipTypes: ["custom"],
				});
				assert.equal(filtered.throughSeq, 4);
				assert.deepEqual(
					filtered.entries.map((item) => item.seq),
					[1, 3, 4],
				);
				const capped = await store.readEntryRange!("session", { fromSeq: 1, toSeq: 4, maxChars: 1 });
				assert.equal(capped.throughSeq, 1);
				assert.deepEqual(
					capped.entries.map((item) => item.seq),
					[1],
				);
				for (const maxChars of [0, -1]) {
					const stopped = await store.readEntryRange!("session", { fromSeq: 2, toSeq: 4, maxChars });
					assert.equal(stopped.throughSeq, 1);
					assert.deepEqual(stopped.entries, []);
				}
				for (const [fromSeq, toSeq] of [
					[1, 0],
					[3, 2],
				] as const) {
					const total = await store.readEntryRange!("session", { fromSeq, toSeq });
					assert.equal(total.lastSeq, 4);
					assert.equal(total.throughSeq, fromSeq - 1);
					assert.deepEqual(total.entries, []);
				}
				const empty = await store.readEntryRange!("session", { fromSeq: 5, toSeq: 8 });
				assert.equal(empty.lastSeq, 4);
				assert.deepEqual(empty.entries, []);
				await assert.rejects(store.readEntryRange!("missing", { fromSeq: 1, toSeq: 1 }), notFound("missing"));
			});

			check("reads a session's tail with the state entries before it (#5249)", async (store, reload) => {
				const entries = compactedSession();
				await appendEach(store, entries);
				store = await reload(store);
				assert.ok(store.readTail && store.readRange && store.findLatestCompaction);
				const tail = await store.readTail("session", 12);
				assert.deepEqual(tail.header, header());
				assert.equal(tail.fromSeq, 12);
				assert.equal(tail.lastSeq, 16);
				assert.deepEqual(tail.entries, entries.slice(11));
				assert.deepEqual(
					tail.state.map(({ seq, entry, onBranch }) => ({ seq, id: entry.id, onBranch })),
					[1, 2, 4, 5, 7, 10, 11].map((seq) => ({ seq, id: entries[seq - 1]!.id, onBranch: true })),
				);
				assert.deepEqual(tail.state[0]!.entry, entries[0]);
				assert.deepEqual(tail.omitted, {
					assistant: usageTotals(),
					toolResult: usageTotals(),
					summaries: usageTotals(),
					userMessages: 1,
					assistantMessages: 0,
					toolResults: 0,
					totalMessages: 1,
					toolCalls: 0,
				});
				const whole = await store.readTail("session", 1);
				assert.deepEqual(whole.entries, entries);
				assert.deepEqual(whole.state, []);
				assert.equal(whole.omitted.totalMessages, 0);
				const none = await store.readTail("session", 17);
				assert.deepEqual(none.entries, []);
				assert.deepEqual(
					none.state.map(({ seq }) => seq),
					[1, 2, 4, 5, 7, 10, 11, 16],
				);
				assert.deepEqual(none.omitted, {
					assistant: usageTotals(tailUsage(256)),
					toolResult: usageTotals(),
					summaries: usageTotals(tailUsage(64)),
					userMessages: 3,
					assistantMessages: 1,
					toolResults: 0,
					totalMessages: 4,
					toolCalls: 1,
				});
				assert.deepEqual(await store.append("session", [message("after", "after")], { expectSeq: 16 }), {
					lastSeq: 17,
				});
				assert.deepEqual((await store.readTail("session", 17)).entries, [message("after", "after")]);
				await assert.rejects(store.readTail("missing", 1), notFound("missing"));
				await assert.rejects(store.readTail("bad\0id", 1), invalidText("sessionId", "nul-character"));
			});

			check("reads a range of a session's entries by seq (#5249)", async (store, reload) => {
				const entries = compactedSession();
				await store.create(header(), entries);
				store = await reload(store);
				assert.ok(store.readRange);
				const firstRange = await store.readRange("session", 3, 5);
				assert.deepEqual(
					{ startSeq: firstRange.startSeq, entries: firstRange.entries, lastSeq: firstRange.lastSeq },
					{
						startSeq: 3,
						entries: entries.slice(2, 5),
						lastSeq: 16,
					},
				);
				assert.deepEqual((await store.readRange("session", 7, 7)).entries, [entries[6]]);
				assert.deepEqual((await store.readRange("session", 15, 40)).entries, entries.slice(14));
				assert.deepEqual((await store.readRange("session", 5, 4)).entries, []);
				assert.deepEqual((await store.readRange("session", 17, 20)).entries, []);
				assert.deepEqual((await store.readRange("session", 1, 16)).entries, entries);
				await assert.rejects(store.readRange("missing", 1, 1), notFound("missing"));
				await store.create(header("empty"), []);
				assert.deepEqual((await store.readRange("empty", 1, 1)).entries, []);
			});

			check("finds the latest compaction on the session's branch (#5249)", async (store, reload) => {
				const entries = compactedSession();
				await appendEach(store, entries);
				await store.create(header("plain"), [message("only", "only")]);
				await store.create(header("empty"), []);
				store = await reload(store);
				assert.ok(store.findLatestCompaction);
				assert.deepEqual(await store.findLatestCompaction("session"), {
					entry: entries[13],
					seq: 14,
					firstKeptSeq: 12,
					retainedStartSeq: 12,
					leafId: "a3",
					lastSeq: 16,
				});
				assert.equal((await store.findLatestCompaction("session", "a2"))?.seq, undefined);
				assert.equal(await store.findLatestCompaction("session", "missing"), undefined);
				assert.equal(await store.findLatestCompaction("plain"), undefined);
				assert.equal(await store.findLatestCompaction("empty"), undefined);
				await assert.rejects(store.findLatestCompaction("missing"), notFound("missing"));
			});

			check("finds the retained start a background compaction leaves (#5249)", async (store, reload) => {
				const entries = chained([
					tailEntry.user("u1"),
					tailEntry.assistant("a1", 128),
					tailEntry.user("u2"),
					tailEntry.assistant("a2", 128),
					tailEntry.compaction("background", null, { coveredThroughEntryId: "u2" }),
					tailEntry.user("u3"),
					tailEntry.compaction("kept", "a1", { coveredThroughEntryId: "u2", parent: "u3" }),
					tailEntry.user("u4"),
					tailEntry.compaction("corrupt", "nowhere"),
				]);
				await appendEach(store, entries);
				store = await reload(store);
				assert.ok(store.findLatestCompaction);
				const corrupt = await store.findLatestCompaction("session");
				assert.deepEqual(
					{ seq: corrupt?.seq, retainedStartSeq: corrupt?.retainedStartSeq, firstKept: corrupt?.firstKeptSeq },
					{ seq: 9, retainedStartSeq: 9, firstKept: undefined },
				);
				const kept = await store.findLatestCompaction("session", "u4");
				assert.deepEqual(
					{ seq: kept?.seq, firstKept: kept?.firstKeptSeq, covered: kept?.coveredThroughSeq },
					{ seq: 7, firstKept: 2, covered: 3 },
				);
				assert.equal(kept?.retainedStartSeq, 2);
				const background = await store.findLatestCompaction("session", "background");
				assert.deepEqual(
					{
						seq: background?.seq,
						covered: background?.coveredThroughSeq,
						retainedStartSeq: background?.retainedStartSeq,
						leafId: background?.leafId,
					},
					{ seq: 5, covered: 3, retainedStartSeq: 4, leafId: "background" },
				);
			});

			check("tells which state entries are on a branched session's branch (#5249)", async (store, reload) => {
				const entries = chained([
					tailEntry.user("r1"),
					tailEntry.model("m0"),
					tailEntry.assistant("b1", 128),
					tailEntry.compaction("cA", null),
					tailEntry.user("a1"),
					tailEntry.model("mA"),
					tailEntry.user("b2", "b2", "b1"),
					tailEntry.thinking("tB"),
					tailEntry.assistant("b3", 128),
				]);
				await appendEach(store, entries);
				store = await reload(store);
				assert.ok(store.readTail && store.findLatestCompaction);
				assert.equal(await store.findLatestCompaction("session"), undefined);
				const onA = await store.findLatestCompaction("session", "mA");
				assert.deepEqual(
					{ seq: onA?.seq, retainedStartSeq: onA?.retainedStartSeq, leafId: onA?.leafId },
					{ seq: 4, retainedStartSeq: 4, leafId: "mA" },
				);
				const tail = await store.readTail("session", 7);
				assert.deepEqual(
					tail.state.map(({ seq, onBranch }) => ({ seq, onBranch })),
					[
						{ seq: 2, onBranch: true },
						{ seq: 3, onBranch: true },
					],
				);
				await store.append(
					"session",
					[{ type: "custom", customType: "atomic.leaf", id: "move", parentId: "mA", timestamp: createdAt }],
					{ expectSeq: 9 },
				);
				const moved = await store.findLatestCompaction("session");
				assert.deepEqual({ seq: moved?.seq, leafId: moved?.leafId }, { seq: 4, leafId: "mA" });
				assert.deepEqual(
					(await store.readTail("session", 7)).state.map(({ seq, onBranch }) => ({ seq, onBranch })),
					[
						{ seq: 2, onBranch: true },
						{ seq: 3, onBranch: true },
						{ seq: 6, onBranch: true },
					],
				);
			});

			check(
				"locates snapshot entries by its index and reads them in selected pages (#5554)",
				async (store, reload) => {
					const record = (id: string, head: string) => ({
						version: 1,
						id,
						root: "/r",
						head,
						tree: `t-${id}`,
						chain: [],
					});
					const snapshot = (
						id: string,
						root: string,
						snapshotId: string,
						fields: Record<string, unknown> = {},
					) => ({
						type: "worktree_snapshot" as const,
						id,
						root,
						snapshotId,
						...fields,
					});
					const restore = { from: "/r", to: "/moved", snapshotId: "a", tree: "t-a", restoredAt: createdAt };
					const entries = chained([
						tailEntry.user("u1"),
						snapshot("s1", "/r", "a", { snapshot: record("a", "1") }),
						tailEntry.user("u2"),
						snapshot("s2", "/r", "b", { snapshot: record("b", "2") }),
						snapshot("s3", "/r", "a"),
						snapshot("s4", "/moved", "a", { restore }),
						tailEntry.user("u3", "u3", "u2"),
						snapshot("s5", "/r", "a", { snapshot: record("a", "3") }),
						snapshot("s6", "/moved", "c", { snapshot: record("c", "4"), degradedFrom: "b" }),
						...Array.from({ length: 70 }, (_, index) => tailEntry.user(`f${index}`)),
						tailEntry.user("large", "x".repeat(SESSION_HISTORY_PAGE_BYTES + 1)),
					]);
					await store.create(header(), entries);
					store = await reload(store);
					if (store.readSnapshotCut === undefined) return;
					assert.ok(store.readSelectedPage && store.readRange);
					const epoch = (await store.readRange("session", 1, 0)).epoch;
					assert.ok(epoch);
					const seqsOf = (ids: readonly string[]) =>
						ids.map((id) => entries.findIndex((entry) => entry.id === id) + 1);
					const includes = (seqs: readonly number[], ids: readonly string[], expected: boolean) => {
						for (const seq of seqsOf(ids)) assert.equal(seqs.includes(seq), expected, `entry ${seq}`);
						assert.deepEqual(
							seqs,
							[...seqs].sort((left, right) => left - right),
						);
					};

					const cut = await store.readSnapshotCut("session");
					assert.ok(cut);
					assert.deepEqual({ epoch: cut.epoch, lastSeq: cut.lastSeq }, { epoch, lastSeq: entries.length });
					assert.deepEqual({ ...cut.records }, { a: 8, b: 4, c: 9 });
					includes(cut.seqs, ["s1", "s2", "s3", "s4", "s5", "s6"], true);
					const active = await store.readSnapshotCut("session", { leafSeq: entries.length });
					includes(active!.seqs, ["s1", "s5", "s6"], true);
					includes(active!.seqs, ["s2", "s3", "s4"], false);
					const abandoned = await store.readSnapshotCut("session", { leafSeq: 6 });
					includes(abandoned!.seqs, ["s1", "s2", "s3", "s4"], true);
					includes(abandoned!.seqs, ["s5", "s6"], false);

					const read = async (seqs: readonly number[], options?: { limit?: number; backward?: boolean }) =>
						(await store.readSelectedPage!("session", seqs, epoch, options)).items.map((item) =>
							"entry" in item ? item.entry : item,
						);
					const snapshots = seqsOf(["s1", "s2", "s3", "s4", "s5", "s6"]);
					assert.deepEqual(
						await read(snapshots),
						entries.slice(0, 9).filter((entry) => entry.id.startsWith("s")),
					);
					assert.deepEqual(await read(snapshots, { limit: 2 }), [entries[1], entries[3]]);
					assert.deepEqual(await read(snapshots, { limit: 2, backward: true }), [entries[7], entries[8]]);
					const small = Array.from({ length: entries.length - 1 }, (_, index) => index + 1);
					assert.deepEqual(await read(small), entries.slice(0, 64));
					assert.deepEqual(await read(small, { backward: true }), entries.slice(-65, -1));
					assert.deepEqual(await read(small, { limit: 4096 }), entries.slice(0, -1));
					const large = entries.length;
					const bytes = Buffer.byteLength(JSON.stringify(entries.at(-1)));
					const reference = { kind: "oversized", sessionId: "session", epoch, seq: large, bytes };
					assert.deepEqual(await read([large - 1, large]), [entries.at(-2)]);
					assert.deepEqual(await read([large - 1, large], { backward: true }), [reference]);
					assert.deepEqual(await read([large]), [reference]);
					assert.deepEqual(await read([]), []);
					for (const [seqs, other] of [
						[[2], "another generation"],
						[[5, 4], epoch],
						[[2, large + 1], epoch],
					] as const)
						await assert.rejects(store.readSelectedPage("session", seqs, other), SessionConflictError);
				},
			);

			check(
				"resumes one branch consistently and changes generation only on replacement (#5249)",
				async (store, reload) => {
					const entries = chained([
						tailEntry.model("model"),
						tailEntry.user("root"),
						tailEntry.assistant("reply", 128),
						tailEntry.user("kept"),
						tailEntry.compaction("boundary", "kept"),
						tailEntry.user("a"),
						tailEntry.user("b", "other", "root"),
						tailEntry.custom("move", "atomic.leaf", undefined, "a"),
					]);
					await store.create(header(), entries);
					store = await reload(store);
					assert.ok(store.readResume && store.readRange && store.findEntrySeq);
					const resumed = await store.readResume("session");
					assert.equal(resumed.leafId, "a");
					assert.equal(resumed.lastEntryId, "move");
					assert.equal(resumed.lastSeq, entries.length);
					assert.equal(
						resumed.branch.some(({ entry }) => entry.id === "b"),
						false,
					);
					const held = [...resumed.state, ...resumed.branch].sort((a, b) => a.seq - b.seq);
					const branch = held
						.filter(
							(item) =>
								resumed.branch.some((other) => other.seq === item.seq) ||
								resumed.state.some((other) => other.seq === item.seq && other.onBranch),
						)
						.map((item) => item.entry);
					const expected = buildSessionProjection(entries, getSessionLeafId(entries));
					const actual = buildSessionProjection(
						held.map((item) => item.entry),
						resumed.leafId,
						undefined,
						undefined,
						branch,
					);
					assert.deepEqual(actual.messages, expected.messages);
					assert.deepEqual(actual.model, expected.model);
					assert.equal(actual.thinkingLevel, expected.thinkingLevel);
					assert.equal(await store.findEntrySeq("session", "root"), 2);
					assert.equal(await store.findEntrySeq("session", "missing"), undefined);
					assert.equal((await store.readRange("session", 1, 2)).epoch, resumed.epoch);
					await store.append("session", [{ ...message("later", "later"), parentId: "a" }], {
						expectSeq: entries.length,
					});
					assert.equal((await store.readResume("session")).epoch, resumed.epoch);
					await store.replace("session", header(), entries, { expectSeq: entries.length + 1 });
					const replacement = await store.readResume("session");
					assert.notEqual(replacement.epoch, resumed.epoch);
					await store.delete("session");
					await store.create(header(), entries);
					assert.notEqual((await store.readResume("session")).epoch, replacement.epoch);
				},
			);

			check(
				"rejects an append or replace carrying a replaced generation's epoch at the same sequence count (#5249)",
				async (store, reload) => {
					const original = [message("first", "first"), { ...message("second", "second"), parentId: "first" }];
					await store.create(header(), original);
					store = await reload(store);
					assert.ok(store.readRange);
					const opened = (await store.readRange("session", 1, 0)).epoch;
					assert.ok(opened);
					const replaced = await store.replace(
						"session",
						header(),
						[message("other", "other"), { ...message("next", "next"), parentId: "other" }],
						{ expectSeq: 2 },
					);
					store = await reload(store);
					const conflict = (error: Error) => error instanceof SessionConflictError;
					await assert.rejects(
						store.append("session", [{ ...message("late", "late"), parentId: "second" }], {
							expectSeq: 2,
							epoch: opened,
						}),
						conflict,
					);
					await assert.rejects(
						store.replace("session", header(), original, { expectSeq: 2, epoch: opened }),
						conflict,
					);
					assert.deepEqual(
						(await store.load("session")).entries.map((entry) => entry.id),
						["other", "next"],
					);
					assert.ok(replaced.epoch);
					await store.append("session", [{ ...message("after", "after"), parentId: "next" }], {
						expectSeq: 2,
						epoch: replaced.epoch,
					});
					assert.equal((await store.load("session")).lastSeq, 3);
				},
			);

			check("create and replace resolve the epoch later range reads report (#5249)", async (store, reload) => {
				const created = await store.create(header(), [message("first", "first")]);
				store = await reload(store);
				assert.ok(store.readRange && created.epoch);
				assert.equal((await store.readRange("session", 1, 1)).epoch, created.epoch);
				await store.append("session", [{ ...message("second", "second"), parentId: "first" }], {
					expectSeq: 1,
					epoch: created.epoch,
				});
				const replaced = await store.replace("session", header(), [message("only", "only")], {
					expectSeq: 2,
					epoch: created.epoch,
				});
				assert.ok(replaced.epoch);
				assert.notEqual(replaced.epoch, created.epoch);
				store = await reload(store);
				assert.equal((await store.readRange!("session", 1, 1)).epoch, replaced.epoch);
				await store.append("session", [{ ...message("third", "third"), parentId: "only" }], {
					expectSeq: 1,
					epoch: replaced.epoch,
				});
				assert.equal((await store.readResume!("session")).epoch, replaced.epoch);
			});

			check(
				"readResume reports pooled delivery receipt ids from before the compaction (#5249)",
				async (store, reload) => {
					const entries = chained([
						tailEntry.user("root"),
						tailEntry.custom("receipt", "atomic-pooled-delivery-op", { op: "delivered-op" }),
						tailEntry.custom("ignored", "atomic-pooled-delivery-op", { op: 3 }),
						tailEntry.user("kept"),
						tailEntry.compaction("boundary", "kept"),
						tailEntry.custom("later", "atomic-pooled-delivery-op", { op: "later-op" }),
					]);
					await store.create(header(), entries);
					store = await reload(store);
					assert.ok(store.readResume);
					const resumed = await store.readResume("session");
					assert.deepEqual(resumed.recovery.deliveryOpIds, ["delivered-op", "later-op"]);
					assert.equal(
						[...resumed.state, ...resumed.branch].some(({ entry }) => entry.id === "receipt"),
						false,
					);
				},
			);

			check("rejects every operation after close, including repeated close", async (store, reload) => {
				await store.create(header(), []);
				store = await reload(store);
				const descriptor = store.descriptor;
				const iterator = store.list({})[Symbol.asyncIterator]();
				assert.equal((await iterator.next()).done, false);
				await store.close();
				const isClosed = (error: Error): boolean => {
					assert.ok(error instanceof StoreClosedError);
					assert.equal(error.adapter, descriptor.adapter);
					assert.equal(error.location, descriptor.location);
					return true;
				};
				await assert.rejects(store.close(), isClosed);
				await assert.rejects(store.create(header(), []), isClosed);
				await assert.rejects(store.append("session", [], { expectSeq: 0 }), isClosed);
				await assert.rejects(store.replace("session", header(), [], { expectSeq: 0 }), isClosed);
				await assert.rejects(store.load("session"), isClosed);
				if (store.readEntryRange !== undefined)
					await assert.rejects(store.readEntryRange("session", { fromSeq: 1, toSeq: 1 }), isClosed);
				await assert.rejects(store.readTail!("session", 1), isClosed);
				await assert.rejects(store.readRange!("session", 1, 1), isClosed);
				await assert.rejects(store.findLatestCompaction!("session"), isClosed);
				await assert.rejects(store.readHeader("session"), isClosed);
				await assert.rejects(store.delete("session"), isClosed);
				await assert.rejects(store.findMostRecent({ cwd: "/project" }), isClosed);
				await assert.rejects(store.list({})[Symbol.asyncIterator]().next(), isClosed);
				await assert.rejects(iterator.next(), isClosed);
			});
		});
	}
}
