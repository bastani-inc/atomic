import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION } from "../src/core/storage/session/types.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import type { InternalSearchRequest } from "../src/core/tools/resource-selectors.js";
import { createSearchToolDefinition } from "../src/core/tools/search.js";

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

async function addSession(store: MemorySessionStore, id: string, at: number, texts: readonly string[]) {
	await store.create(
		{ id, version: SESSION_FORMAT_VERSION, createdAt: new Date(at).toISOString(), cwd: PROJECT },
		texts.map((text, index) => message(`${id}-e${index + 1}`, text, at + index)),
	);
}

describe("history:// continuation chains cover each entry once", () => {
	for (const first of ["history://sessions?limit=2", "history://sessions"]) {
		it(`a session the chain has not reached yet that gets new activity is still searched, once (${first})`, async () => {
			const store = new MemorySessionStore();
			for (let n = 1; n <= 6; n++) await addSession(store, `s${n}`, BASE + n * 60_000, [`needle s${n}`]);
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => store,
				...(first.includes("limit") ? {} : { budget: { bytes: 600 } }),
			});
			const urls: string[] = [];
			const outputs: string[] = [];
			let url: string | undefined = first;
			let touched = false;
			for (let call = 0; url !== undefined && call < 30; call++) {
				urls.push(url);
				const out = (await router.search!(url, request("needle"))) ?? "";
				outputs.push(out);
				if (!touched) {
					touched = true;
					await store.append("s1", [message("s1-late", "nothing to find", BASE + 1000 * 60_000)], {
						expectSeq: 1,
					});
				}
				url = continuation(out);
			}
			const rows = outputs.flatMap((out) => [...out.matchAll(/: (needle s\d)$/gm)].map((match) => match[1]!));
			assert.deepEqual(
				[...rows].sort(),
				["needle s1", "needle s2", "needle s3", "needle s4", "needle s5", "needle s6"],
				`${urls.join("\n")}\n---\n${outputs.join("\n---\n")}`,
			);
		});
	}

	it("keeps the activity order even when one older conversation was already active before the first page", async () => {
		const store = new MemorySessionStore();
		for (let i = 1; i <= 8; i++) await addSession(store, `session-${i}`, BASE + i * 60_000, [`needle session-${i}`]);
		await store.append("session-1", [message("first-change", "updated before searching", BASE + 60 * 60_000)], {
			expectSeq: 1,
		});
		const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
		const rows: string[] = [];
		let url: string | undefined = "history://sessions?limit=2";
		for (let call = 0; url && call < 10; call++) {
			const text = (await router.search!(url, request("needle")))!;
			rows.push(...[...text.matchAll(/: needle (session-\d)$/gm)].map((hit) => hit[1]!));
			if (call === 0)
				await store.append("session-2", [message("second-change", "updated while searching", BASE + 65 * 60_000)], {
					expectSeq: 1,
				});
			url = continuation(text);
		}
		assert.deepEqual(rows, [
			"session-1",
			"session-8",
			"session-7",
			"session-6",
			"session-5",
			"session-4",
			"session-3",
			"session-2",
		]);
	});

	it("two sessions created together can share a correction without losing the next session", async () => {
		const store = new MemorySessionStore();
		for (const [i, id] of ["a", "b", "c"].entries()) {
			await addSession(store, id, BASE + (i === 2 ? 1 : 0), [`needle ${id}`]);
			await store.append(id, [message(`prior-${id}`, "prior activity", BASE + 40 - i)], { expectSeq: 1 });
		}
		const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
		const rows: string[] = [];
		let url: string | undefined = "history://sessions?limit=1";
		for (let i = 0; url && i < 6; i++) {
			const text = (await router.search!(url, request("needle")))!;
			rows.push(...[...text.matchAll(/: needle ([abc])$/gm)].map((hit) => hit[1]!));
			if (i === 0) await store.append("c", [message("new", "new activity", BASE + 100)], { expectSeq: 2 });
			url = continuation(text);
		}
		assert.deepEqual(rows, ["a", "b", "c"]);
	});

	it.each([
		{ sessions: 10, padding: 473, matches: 100, skipHint: false },
		{ sessions: 20, padding: 230, matches: 190, skipHint: true },
	])(
		"a continuation never displaces a match or skip hint from the combined page ($matches matches)",
		async (fixture) => {
			const store = new MemorySessionStore();
			await addSession(store, "older", BASE, ["needle older"]);
			for (let s = 1; s <= fixture.sessions; s++) {
				const rows = Array.from({ length: 10 }, (_, i) => `needle ${s} ${i} ${"x".repeat(fixture.padding)}`);
				await addSession(store, `s${s}`, BASE + s * 60_000, rows);
			}
			const paths = [
				"history://sessions?limit=1",
				...Array.from(
					{ length: fixture.sessions - 1 },
					(_, i) => `history://sessions/s${fixture.sessions - 1 - i}`,
				),
			];
			const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
			const result = await createSearchToolDefinition(PROJECT, { contextBefore: 0, contextAfter: 0 }).execute(
				"search",
				{ pattern: "needle", paths },
				undefined,
				undefined,
				{ cwd: PROJECT, internalResourceRouter: router } as never,
			);
			const block = result.content[0];
			assert.ok(block?.type === "text");
			assert.equal(block.text.match(/: needle /g)?.length, fixture.matches);
			assert.equal(block.text.endsWith("[20 matching files shown. Use skip=20 to view more.]"), fixture.skipHint);
			assert.equal(result.details?.matchCount, fixture.matches + 1);
			assert.equal(result.details?.truncation, undefined);
		},
	);

	it("a read of a printed session cursor still fits the listing's own budget", async () => {
		const store = new MemorySessionStore();
		const at = 1_700_000_000_000;
		for (let i = 0; i < 3; i++) await addSession(store, `s${i}`, at - i, ["needle"]);
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			budget: { bytes: 245 },
		});
		const first = (await router.search!("history://sessions?limit=1", request("needle")))!;
		const next = continuation(first)!;
		const expected = `history://sessions?offset=1&limit=1&after=${at}.${at}.s0`;
		const read = await router.read!(next);
		assert.equal(read, await router.read!(expected));
		assert.ok(read?.includes(`continue with ${expected}&cursor=2:2-2]`), read);
	});

	it("validates an ordinary history URL before asking a retired extension for its cancellation signal", async () => {
		const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => undefined });
		const query = {
			...request("needle"),
			get signal(): AbortSignal {
				throw new Error("retired extension context");
			},
		};
		await assert.rejects(router.search!("history://sessions?limit=0", query), /history limit must be/);
	});

	it("an abandoned chain does not need its original router or a free slot in a process cache", async () => {
		const store = new MemorySessionStore();
		for (let i = 0; i < 4; i++) await addSession(store, `s${i}`, BASE + i, [`needle s${i}`]);
		const open = () => createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
		const path = "history://sessions?limit=1";
		let next = continuation((await open().search!(path, request("needle")))!);
		const other = open();
		for (let i = 0; i < 40; i++) await other.search!(path, request("needle"));
		await store.append("s0", [message("late", "activity", BASE + 100)], { expectSeq: 1 });
		const rows: string[] = [];
		for (let i = 0; next && i < 8; i++) {
			const page = (await open().search!(next, request("needle")))!;
			rows.push(...[...page.matchAll(/: needle (s\d)/g)].map((hit) => hit[1]!));
			next = continuation(page);
		}
		assert.deepEqual(rows, ["s2", "s1", "s0"]);
	});

	it("a string-only router and a saved legacy URL count the same coverage row once", async () => {
		const store = new MemorySessionStore();
		for (let i = 1; i <= 5; i++) await addSession(store, `s${i}`, BASE + i, [`needle s${i}`]);
		const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
		const saved = `history://sessions?offset=1&limit=1&after=${BASE + 5}.${BASE + 5}.s5`;
		await store.delete("s5");
		const outside = new AsyncResource("independent history reader");
		try {
			assert.equal(
				await outside.runInAsyncScope(() => router.search!(saved, request("needle"))),
				`history://sessions?limit=1:0: [searched sessions 1-1 of 4; continue with history://sessions?offset=1&limit=1&after=${BASE + 4}.${BASE + 4}.s4]\nhistory://sessions/s4:1: needle s4`,
			);
			const result = await createSearchToolDefinition(PROJECT, { contextBefore: 0, contextAfter: 0 }).execute(
				"overlap",
				{ pattern: "needle", paths: ["history://sessions?limit=1", saved] },
				undefined,
				undefined,
				{
					cwd: PROJECT,
					internalResourceRouter: {
						search: (url: string, query: InternalSearchRequest) =>
							outside.runInAsyncScope(() => router.search!(url, query)),
					},
				} as never,
			);
			assert.equal(result.details?.matchCount, 2);
			const block = result.content[0];
			assert.ok(block?.type === "text");
			assert.equal(block.text.match(/; continue with /g)?.length, 1);
		} finally {
			outside.emitDestroy();
		}
	});

	it("similar-looking extension annotations stay distinct", async () => {
		const note =
			"history://sessions:0: [searched release annotations; continue with history://sessions?report=weekly";
		const result = await createSearchToolDefinition(PROJECT).execute(
			"annotations",
			{ pattern: "needle", paths: ["artifact://note-one", "artifact://note-two"] },
			undefined,
			undefined,
			{
				cwd: PROJECT,
				internalResourceRouter: {
					search: (url: string) =>
						`${note}${url.endsWith("one") ? "&order=c" : ""}]\nhistory://sessions/source:1: needle`,
				},
			} as never,
		);
		assert.equal(result.details?.matchCount, 3);
	});

	it.each([
		["history://sessions?offset=1&limit=1&release=weekly", "searched sessions 2-2 of 4"],
		["history://sessions?offset=1&limit=1", "searched sessions 2-2 of 4; release candidates compared by hand"],
		["history://sessions?offset=1&limit=1", "searched sessions 2-1 of 4"],
	])("preserves stored annotations with a foreign label or description: %s %s", async (label, description) => {
		const links = [
			"history://sessions?offset=2&limit=1&after=mppy1i4j..s3&o=c!!!!!!!!!!!!!!",
			"history://sessions?offset=2&limit=1&after=1780000000003.1780000000003.s3",
		];
		const notes = links.map((url) => `${label}:0: [${description}; continue with ${url}]`);
		const result = await createSearchToolDefinition(PROJECT).execute(
			"stored",
			{ pattern: "release", paths: ["artifact://one", "artifact://two"] },
			undefined,
			undefined,
			{
				cwd: PROJECT,
				internalResourceRouter: {
					search: (url: string) => `${notes[url.endsWith("one") ? 0 : 1]}\nhistory://sessions/source:1: release`,
				},
			} as never,
		);
		assert.equal(result.details?.matchCount, 3);
		const text = result.content[0];
		assert.ok(text?.type === "text");
		assert.deepEqual(
			text.text.split("\n").filter((line) => line.includes("; continue with")),
			notes,
		);
	});
});
