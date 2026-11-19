import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionListQuery,
	type SessionRecordHeader,
	type SessionStore,
	type SessionSummary,
} from "../src/core/storage/session/types.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import type { InternalReadSelection, InternalSearchRequest } from "../src/core/tools/resource-selectors.js";

const PROJECT = resolve("/projects/history-continuations");
const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const STORE_WAIT_BUDGET_MS = 50;
const CALL_LIMIT = 200;

interface Gate {
	readonly opened: Promise<void>;
	readonly open: () => void;
}

class Gates {
	private readonly waiting: Gate[] = [];

	next(): Promise<void> {
		let open = () => {};
		const opened = new Promise<void>((resolve) => {
			open = resolve;
		});
		this.waiting.push({ opened, open });
		return opened;
	}

	openAll(): void {
		for (const gate of this.waiting.splice(0)) gate.open();
	}
}

function message(id: string, text: string, at: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		message: { role: "user", content: text, timestamp: at },
	};
}

async function storeWith(count: number, entries: (session: number) => SessionEntry[]): Promise<MemorySessionStore> {
	const store = new MemorySessionStore();
	for (let index = 0; index < count; index++) {
		await store.create(
			{
				id: `s${index + 1}`,
				version: SESSION_FORMAT_VERSION,
				createdAt: new Date(BASE + index * 60_000).toISOString(),
				cwd: PROJECT,
			},
			entries(index + 1),
		);
	}
	return store;
}

function listingWaitsAfterFirst(store: SessionStore, gates: Gates): SessionStore {
	return new Proxy(store, {
		get(target, key) {
			if (key === "list")
				return (query: SessionListQuery) => {
					const inner = target.list(query);
					return (async function* () {
						let yielded = 0;
						for await (const summary of inner as AsyncIterable<SessionSummary>) {
							if (yielded === 1) await gates.next();
							yielded++;
							yield summary;
						}
					})();
				};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function headerWaitsOnce(store: SessionStore, sessionId: string, gates: Gates): SessionStore {
	let waited = false;
	return new Proxy(store, {
		get(target, key) {
			if (key === "readHeader")
				return async (id: string): Promise<SessionRecordHeader | undefined> => {
					if (id === sessionId && !waited) {
						waited = true;
						await gates.next();
					}
					return target.readHeader(id);
				};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function continuation(text: string): string | undefined {
	return /continue with (history:\/\/\S+?)\]?$/m.exec(text)?.[1];
}

function request(pattern: string, ranges?: InternalSearchRequest["ranges"]): InternalSearchRequest {
	return {
		pattern,
		ignoreCase: false,
		literal: false,
		contextBefore: 0,
		contextAfter: 0,
		...(ranges === undefined ? {} : { ranges }),
	};
}

interface SearchChain {
	readonly outputs: string[];
	readonly urls: string[];
	readonly matches: string[];
	readonly finished: boolean;
}

async function followSearch(
	search: (url: string, call: number) => Promise<string>,
	first: string,
	match: RegExp,
	afterCall: (call: number) => void = () => {},
): Promise<SearchChain> {
	const outputs: string[] = [];
	const urls: string[] = [];
	const matches: string[] = [];
	let url: string | undefined = first;
	for (let call = 0; url !== undefined && call < CALL_LIMIT; call++) {
		urls.push(url);
		const output = await search(url, call);
		outputs.push(output);
		for (const found of output.matchAll(match)) matches.push(found[1]!);
		url = continuation(output);
		afterCall(call);
	}
	return { outputs, urls, matches, finished: url === undefined };
}

function assertEachOnce(chain: SearchChain, expected: readonly string[]): void {
	const trail = `urls:\n${chain.urls.slice(0, 24).join("\n")}`;
	assert.ok(chain.finished, `the search never finished; ${trail}`);
	assert.deepEqual(
		chain.matches.filter((found, index) => chain.matches.indexOf(found) !== index),
		[],
		`matches returned twice; ${trail}`,
	);
	assert.deepEqual([...chain.matches].sort(), [...expected].sort(), trail);
}

describe("history:// continuations resume where a call stopped (#5250)", () => {
	it("a session listing that stops while listing sessions keeps the requested lines in its continuation (#5250)", async () => {
		const store = await storeWith(8, (n) => [message(`e${n}`, `hello ${n}`, BASE + n)]);
		const reads: readonly { readonly url: string; readonly selection: InternalReadSelection }[] = [
			{ url: "history://sessions", selection: { ranges: [{ start: 2, end: 3 }] } },
			{ url: "history://sessions", selection: { ranges: [{ start: 2, end: 3 }], raw: true } },
			{ url: "history://sessions", selection: { ranges: [{ start: 2, end: 2 }, { start: 8 }] } },
			{ url: "history://sessions", selection: { offset: 3, limit: 2 } },
			{ url: "history://sessions", selection: { offset: 6 } },
			{ url: "history://sessions?cursor=3.5:3-6", selection: {} },
		];
		const whole = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
		const expected: string[] = [];
		for (const { url, selection } of reads) expected.push((await whole.readSelected!(url, selection)) ?? "");
		const budgeted = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			budget: { rows: 3 },
		});
		for (const [index, { url, selection }] of reads.entries()) {
			let output = (await budgeted.readSelected!(url, selection)) ?? "";
			const first = output;
			for (let call = 0; call < CALL_LIMIT; call++) {
				const next = continuation(output);
				if (next === undefined) break;
				output = (await budgeted.readSelected!(next, {})) ?? "";
			}
			assert.match(first, /scanned \d+ sessions so far/, "the listing should stop while listing sessions");
			assert.equal(output, expected[index], `${url} ${JSON.stringify(selection)}; first page:\n${first}`);
		}
	});

	it("a read whose store wait ran out of time continues with the lines or entries it was asked for (#5250)", async () => {
		const store = await storeWith(1, () =>
			Array.from({ length: 6 }, (_, index) => message(`e${index}`, `entry ${index + 1}`, BASE + index)),
		);
		const reads: readonly { readonly url: string; readonly selection: InternalReadSelection }[] = [
			{ url: "history://sessions/s1", selection: { ranges: [{ start: 3, end: 4 }] } },
			{ url: "history://sessions/s1", selection: { offset: 5 } },
		];
		const whole = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
		for (const { url, selection } of reads) {
			const expected = (await whole.readSelected!(url, selection)) ?? "";
			const gates = new Gates();
			const slowStore = headerWaitsOnce(store, "s1", gates);
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => slowStore,
				budget: { timeMs: STORE_WAIT_BUDGET_MS },
			});
			const stopped = (await router.readSelected!(url, selection)) ?? "";
			gates.openAll();
			const next = continuation(stopped);
			assert.ok(next !== undefined, stopped);
			assert.equal(
				(await whole.readSelected!(next, {})) ?? "",
				expected,
				`${url} ${JSON.stringify(selection)}: ${next}`,
			);
		}
	});

	it("a multi-session search that stops inside a session resumes there when listing sessions takes more than one call (#5250)", async () => {
		const gates = new Gates();
		const store = await storeWith(4, (n) =>
			Array.from({ length: 6 }, (_, index) =>
				message(`e${n}-${index}`, `needle s${n} e${index + 1} ${"x".repeat(40)}`, BASE + n),
			),
		);
		const listed = listingWaitsAfterFirst(store, gates);
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => listed,
			budget: { timeMs: STORE_WAIT_BUDGET_MS, bytes: 400 },
		});
		const chain = await followSearch(
			async (url) => (await router.search!(url, request("needle"))) ?? "",
			"history://sessions",
			/: (needle s\d+ e\d+)/g,
			() => gates.openAll(),
		);
		assert.ok(
			chain.urls.some((url) => url.includes("session=")),
			`the search should stop inside a session at least once; urls:\n${chain.urls.join("\n")}`,
		);
		assertEachOnce(
			chain,
			Array.from({ length: 24 }, (_, index) => `needle s${Math.floor(index / 6) + 1} e${(index % 6) + 1}`),
		);
	});

	it("a session search resumed in one session does not take over the unfinished listing of a search resumed in another session at the same position (#5250)", async () => {
		const store = await storeWith(3, (n) =>
			Array.from({ length: 4 }, (_, index) => message(`e${n}-${index}`, `needle s${n} e${index + 1}`, BASE + n)),
		);
		const gates = new Gates();
		let holding = true;
		const listed = new Proxy(store, {
			get(target, key) {
				if (key === "list")
					return (query: SessionListQuery) =>
						(async function* () {
							const snapshot: SessionSummary[] = [];
							for await (const summary of target.list(query)) snapshot.push(summary);
							for (const [index, summary] of snapshot.entries()) {
								if (index === 1 && holding) await gates.next();
								yield summary;
							}
						})();
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => listed,
			budget: { timeMs: STORE_WAIT_BUDGET_MS },
		});
		const stopped = (await router.search!("history://sessions?session=s2&cursor=3", request("needle"))) ?? "";
		assert.match(
			stopped,
			/after scanning 1 sessions; continue with history:\/\/sessions\?session=s2&cursor=3\]$/m,
			stopped,
		);
		await store.create(
			{ id: "s9", version: SESSION_FORMAT_VERSION, createdAt: new Date(BASE + 600_000).toISOString(), cwd: PROJECT },
			Array.from({ length: 4 }, (_, index) => message(`e9-${index}`, `needle s9 e${index + 1}`, BASE + 600_000)),
		);
		holding = false;
		gates.openAll();
		const other = (await router.search!("history://sessions?session=s9&cursor=3", request("needle"))) ?? "";
		assert.doesNotMatch(other, /no longer listed/, other);
		assert.deepEqual(
			[...other.matchAll(/: (needle s9 e\d)$/gm)].map((match) => match[1]),
			["needle s9 e3", "needle s9 e4"],
			other,
		);
	});
});
