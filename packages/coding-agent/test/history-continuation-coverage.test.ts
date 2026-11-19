import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION } from "../src/core/storage/session/types.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import type { InternalSearchRequest } from "../src/core/tools/resource-selectors.js";
import { createSearchToolDefinition } from "../src/core/tools/search.js";

/**
 * Following every `continue with` URL a history:// search hands back covers each entry exactly once: nothing is
 * skipped and nothing shown twice, whatever stops a call and whatever changes in the store between calls.
 */

const PROJECT = resolve("/projects/history-continuation-coverage");
const BASE = Date.parse("2026-11-01T00:00:00.000Z");

function message(id: string, text: string, at: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		message: { role: "user", content: text, timestamp: at },
	};
}

const request = (pattern: string): InternalSearchRequest => ({
	pattern,
	ignoreCase: false,
	literal: false,
	contextBefore: 0,
	contextAfter: 0,
});
const continuation = (text: string) => /continue with (history:\/\/\S+?)\]?$/m.exec(text)?.[1];

describe("history:// continuation chains cover each entry once", () => {
	async function addSession(store: MemorySessionStore, id: string, at: number, texts: readonly string[]) {
		await store.create(
			{ id, version: SESSION_FORMAT_VERSION, createdAt: new Date(at).toISOString(), cwd: PROJECT },
			texts.map((text, index) => message(`${id}-e${index + 1}`, text, at + index)),
		);
	}

	it("abandoned listings do not stall the next cursor (#5479)", async () => {
		const store = new MemorySessionStore();
		for (let n = 0; n < 3; n++) await addSession(store, `s${n}`, BASE + n, ["needle"]);
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			workflows: () => undefined,
			budget: { rows: 1 },
		});
		const base = "history://sessions";
		for (let abandoned = 0; abandoned < 16; abandoned++) await router.read!(base);
		let url: string | undefined = base,
			output = "";
		for (let i = 0; i < 4 && url; i++) {
			output = String(await router.read!(url));
			url = continuation(output);
		}
		assert.equal(url, undefined, output);
		for (let n = 0; n < 3; n++) assert.ok(output.includes(`${base}/s${n}`), output);
	});

	it("keeps a resumable cursor when the listing note just fits (#5479)", async () => {
		const store = new MemorySessionStore();
		await addSession(store, "s0", BASE, ["needle"]);
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			workflows: () => undefined,
			budget: { rows: 1, bytes: 144 },
		});
		const first = await router.search!("history://sessions", request("needle"));
		const next = continuation(first!);
		assert.equal(next, "history://sessions?cursor=0.1", first);
		assert.match((await router.search!(next, request("needle")))!, /:1: needle/);
	});

	it("a session that moves ahead of a search between pages is still searched once (#5692)", async () => {
		const store = new MemorySessionStore();
		for (let n = 1; n <= 6; n++) await addSession(store, `s${n}`, BASE + n * 60_000, [`needle s${n}`]);
		const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => undefined });
		const pages: string[] = [];
		let url: string | undefined = "history://sessions?limit=2";
		while (url && pages.length < 10) {
			const page = (await router.search!(url, request("needle")))!;
			pages.push(page);
			if (pages.length === 1)
				await store.append("s1", [message("s1-late", "more activity", BASE + 1_000_000)], { expectSeq: 1 });
			url = continuation(page);
		}
		assert.equal(url, undefined);
		assert.deepEqual(
			pages.flatMap((page) => [...page.matchAll(/: needle (s\d)$/gm)].map((hit) => hit[1])),
			["s6", "s5", "s4", "s3", "s2", "s1"],
			pages.join("\n"),
		);
	});

	async function searchPaths(store: MemorySessionStore, paths: string[], observe?: (text: string) => void) {
		const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => undefined });
		const search = async (url: string, request: InternalSearchRequest) => {
			const text = await router.search!(url, request);
			if (text !== undefined) observe?.(text);
			return text;
		};
		return createSearchToolDefinition(PROJECT, { contextBefore: 0, contextAfter: 0 }).execute(
			"search",
			{ pattern: "needle", paths },
			undefined,
			undefined,
			{ cwd: PROJECT, internalResourceRouter: { search } } as never,
		);
	}

	it("overlapping listings share a continuation and count its note once (#5692)", async () => {
		const store = new MemorySessionStore();
		await addSession(store, "s1", BASE, ["needle first"]);
		await addSession(store, "s2", BASE + 1, ["needle second"]);
		const path = "history://sessions?limit=1";
		const cursors: (string | undefined)[] = [];
		const result = await searchPaths(store, [path, path], (text) => cursors.push(continuation(text)));
		assert.equal(cursors.length, 2);
		assert.equal(cursors[0], cursors[1]);
		const block = result.content[0];
		assert.ok(block?.type === "text");
		assert.equal(block.text.match(/&order=[A-Za-z0-9_-]{22}/g)?.length, 1, block.text);
		assert.equal(result.details?.matchCount, 2);
		assert.deepEqual(result.details?.fileMatches, { [path]: 1, "history://sessions/s2": 1 });
	});

	it.each([
		{ sessions: 10, padding: 473, matches: 100, skipHint: false },
		{ sessions: 20, padding: 230, matches: 190, skipHint: true },
	])("an order token never displaces the last match or skip hint ($matches matches, #5692)", async (fixture) => {
		const store = new MemorySessionStore();
		await addSession(store, "older", BASE, ["needle older"]);
		for (let s = 1; s <= fixture.sessions; s++) {
			const rows = Array.from({ length: 10 }, (_, i) => `needle ${s} ${i} ${"x".repeat(fixture.padding)}`);
			await addSession(store, `s${s}`, BASE + s * 60_000, rows);
		}
		const paths = [
			"history://sessions?limit=1",
			...Array.from({ length: fixture.sessions - 1 }, (_, i) => `history://sessions/s${fixture.sessions - 1 - i}`),
		];
		const result = await searchPaths(store, paths);
		const block = result.content[0];
		assert.ok(block?.type === "text");
		assert.equal(block.text.match(/: needle /g)?.length, fixture.matches);
		assert.equal(block.text.endsWith("[20 matching files shown. Use skip=20 to view more.]"), fixture.skipHint);
		assert.equal(result.details?.matchCount, fixture.matches + 1);
		assert.equal(result.details?.truncation, undefined);
	});

	it("a page keeps the legacy URL rather than dropping a match to fit an order token (#5692)", async () => {
		const store = new MemorySessionStore();
		for (let n = 1; n <= 2; n++) await addSession(store, `s${n}`, BASE + n * 60_000, [`needle s${n}`]);
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			workflows: () => undefined,
			budget: { bytes: 181 },
		});
		const page = (await router.search!("history://sessions?limit=1", request("needle")))!;
		const legacy = "history://sessions?offset=1&limit=1&after=1793491320000.1793491320000.s2";
		assert.equal(
			page,
			`history://sessions?limit=1:0: [searched sessions 1-1 of 2; continue with ${legacy}]\nhistory://sessions/s2:1: needle s2`,
		);
		assert.match((await router.search!(legacy, request("needle")))!, /:1: needle s1$/m);
	});

	it("an evicted order resumes exactly like the standalone session position (#5692)", async () => {
		const store = new MemorySessionStore();
		for (let n = 1; n <= 3; n++) await addSession(store, `s${n}`, BASE + n * 60_000, [`needle s${n}`]);
		const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => undefined });
		const first = "history://sessions?limit=1";
		const next = continuation((await router.search!(first, request("needle")))!)!;
		assert.match(next, /&order=[A-Za-z0-9_-]{22}$/);
		for (let abandoned = 0; abandoned < 32; abandoned++) await router.search!(first, request("needle"));
		await store.append("s2", [message("s2-late", "more activity", BASE + 1_000_000)], { expectSeq: 1 });
		const afterEviction = await router.search!(next, request("needle"));
		assert.equal(afterEviction, await router.search!(next.split("&order=")[0]!, request("needle")));
		assert.match(afterEviction!, /:1: needle s1$/m);
		assert.doesNotMatch(afterEviction!, /:1: needle s2$/m);
		await assert.rejects(
			router.search!(`${first}&order=${"a".repeat(23)}`, request("needle")),
			/history order must be the token/,
		);
	});

	it("a session created after a search chain started is left out of it", async () => {
		const store = new MemorySessionStore();
		for (let n = 1; n <= 4; n++) await addSession(store, `s${n}`, BASE + n * 60_000, [`needle s${n}`]);
		const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => undefined });
		const outputs: string[] = [];
		let url: string | undefined = "history://sessions?limit=2";
		for (let call = 0; url !== undefined && call < 10; call++) {
			const out = (await router.search!(url, request("needle"))) ?? "";
			outputs.push(out);
			if (call === 0) await addSession(store, "late", BASE + 100 * 60_000, ["needle late"]);
			url = continuation(out);
		}
		const rows = outputs.flatMap((out) => [...out.matchAll(/: (needle \w+)$/gm)].map((match) => match[1]!));
		assert.deepEqual([...rows].sort(), ["needle s1", "needle s2", "needle s3", "needle s4"], outputs.join("\n---\n"));
	});
});
