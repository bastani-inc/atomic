import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION } from "../src/core/storage/session/types.js";
import { createHistoryRouter, type HistoryBudget } from "../src/core/tools/history-protocol.js";
import type {
	InternalReadSelection,
	InternalResourceRouter,
	InternalSearchRequest,
} from "../src/core/tools/resource-selectors.js";
import { createSessionHistoryToolDefinition } from "../src/core/tools/session-history.js";

const PROJECT = resolve("/projects/session-history-tool");
const BASE = Date.parse("2026-11-01T00:00:00.000Z");

function userEntry(id: string, text: string, index: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: index === 0 ? null : `e-${index - 1}`,
		timestamp: new Date(BASE + index * 1_000).toISOString(),
		message: { role: "user", content: text, timestamp: BASE + index * 1_000 },
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

async function createStoreWithSession(
	sessionId: string,
	entries: SessionEntry[],
	budget?: Partial<HistoryBudget>,
): Promise<{ store: MemorySessionStore; router: InternalResourceRouter }> {
	const store = new MemorySessionStore();
	await store.create(
		{
			id: sessionId,
			version: SESSION_FORMAT_VERSION,
			createdAt: new Date(BASE).toISOString(),
			cwd: PROJECT,
		},
		entries,
	);
	await store.create(
		{
			id: "foreign-session",
			version: SESSION_FORMAT_VERSION,
			createdAt: new Date(BASE + 10_000).toISOString(),
			cwd: PROJECT,
		},
		[userEntry("f-0", "foreign secret entry", 0)],
	);
	const router = createHistoryRouter({
		cwd: PROJECT,
		currentSessionId: sessionId,
		sessionStore: () => store,
		budget,
	});
	return { store, router };
}

describe("session_history tool (#5250)", () => {
	it("describes lines as an entry range and continuation target while preserving schema keys [lines, pattern] (#5250)", () => {
		const tool = createSessionHistoryToolDefinition("session_history", {
			sessionId: () => "s-own",
			router: () => ({}),
		});
		const props = (tool.parameters as { properties: Record<string, { description?: string }> }).properties;
		assert.deepEqual(Object.keys(props).sort(), ["lines", "pattern"]);
		assert.match(props.lines?.description ?? "", /entr(?:y|ies)/i);
		assert.match(props.pattern?.description ?? "", /lines.*\?cursor=/i);
		assert.match(tool.description, /entr(?:y|ies)/i);
	});

	it("calls router.readSelected with bounded entry ranges instead of router.read whole-session outline (#5250)", async () => {
		const entries = Array.from({ length: 2_100 }, (_, i) =>
			userEntry(`e-${i}`, `entry payload ${i + 1}: needle-${i + 1}`, i),
		);
		const { router } = await createStoreWithSession("s-long", entries);
		let bareReadCalled = false;
		const wrappedRouter: InternalResourceRouter = {
			...router,
			read: async (url) => {
				bareReadCalled = true;
				return router.read?.(url);
			},
		};
		const tool = createSessionHistoryToolDefinition("session_history", {
			sessionId: () => "s-long",
			router: () => wrappedRouter,
		});
		const ctx = {} as Parameters<typeof tool.execute>[4];

		const searched = textOf(await tool.execute("call-1", { pattern: "needle-2050" }, undefined, undefined, ctx));
		assert.ok(searched.includes("history://sessions/s-long:2050:"), searched);

		const opened = textOf(await tool.execute("call-2", { lines: "2050-2051" }, undefined, undefined, ctx));
		assert.equal(bareReadCalled, false, "must not call bare router.read(url)");
		assert.match(opened, /^# session s-long entries 2050-2051 of 2100\n/u);
		assert.ok(opened.includes("needle-2050"), opened);
		assert.ok(opened.includes("needle-2051"), opened);
	});

	it("forwards execute AbortSignal (including pre-aborted signals) and rejects when readSelected/search are unavailable (#5250)", async () => {
		let searchSignal: AbortSignal | undefined;
		let readSignal: AbortSignal | undefined;
		let readSelection: InternalReadSelection | undefined;
		let searchRequest: InternalSearchRequest | undefined;
		const router: InternalResourceRouter = {
			search: async (_url, request) => {
				searchRequest = request;
				searchSignal = request.signal;
				request.signal?.throwIfAborted();
				return "history://sessions/s-sig:3: matched";
			},
			readSelected: async (_url, selection) => {
				readSelection = selection;
				readSignal = selection.signal;
				selection.signal?.throwIfAborted();
				return "# session s-sig entries 3-4 of 10\nmatched";
			},
		};
		const tool = createSessionHistoryToolDefinition("session_history", {
			sessionId: () => "s-sig",
			router: () => router,
		});
		const controller = new AbortController();
		const ctx = {} as Parameters<typeof tool.execute>[4];

		await tool.execute("call-s", { pattern: "matched" }, controller.signal, undefined, ctx);
		assert.equal(searchSignal, controller.signal);
		assert.equal(searchRequest?.pattern, "matched");

		await tool.execute("call-r", { lines: "3-4" }, controller.signal, undefined, ctx);
		assert.equal(readSignal, controller.signal);
		assert.deepEqual(readSelection?.ranges, [{ start: 3, end: 4 }]);

		controller.abort(new Error("cancelled-by-caller"));
		await assert.rejects(
			() => tool.execute("call-s-abort", { pattern: "matched" }, controller.signal, undefined, ctx),
			/cancelled-by-caller/,
		);
		await assert.rejects(
			() => tool.execute("call-r-abort", { lines: "3-4" }, controller.signal, undefined, ctx),
			/cancelled-by-caller/,
		);

		const emptyTool = createSessionHistoryToolDefinition("session_history", {
			sessionId: () => "s-empty",
			router: () => ({ read: async () => "legacy transcript" }),
		});
		await assert.rejects(
			() => emptyTool.execute("call-no-read-selected", { lines: "1-2" }, undefined, undefined, ctx),
			/Bounded history read is unavailable/,
		);
		await assert.rejects(
			() => emptyTool.execute("call-no-search", { pattern: "foo" }, undefined, undefined, ctx),
			/Bounded history search is unavailable/,
		);
	});

	it("caps requested entry range span to 400 entries (including near MAX_SAFE_INTEGER) and advances read/search continuations within own session (#5250)", async () => {
		const entries = Array.from({ length: 30 }, (_, i) =>
			userEntry(`e-${i}`, `entry-${i + 1} match-token ${"x".repeat(400)}`, i),
		);
		const { router } = await createStoreWithSession("s-cont", entries, { bytes: 1_200 });
		let lastSelection: InternalReadSelection | undefined;
		const spiedRouter: InternalResourceRouter = {
			...router,
			readSelected: async (url, selection) => {
				lastSelection = selection;
				return router.readSelected?.(url, selection);
			},
		};
		const tool = createSessionHistoryToolDefinition("session_history", {
			sessionId: () => "s-cont",
			router: () => spiedRouter,
		});
		const ctx = {} as Parameters<typeof tool.execute>[4];

		await tool.execute("call-cap", { lines: "10-900" }, undefined, undefined, ctx);
		assert.deepEqual(lastSelection?.ranges, [{ start: 10, end: 409 }]);

		const nearMax = Number.MAX_SAFE_INTEGER - 10;
		await tool.execute(
			"call-near-max",
			{ lines: `${nearMax}-${Number.MAX_SAFE_INTEGER}` },
			undefined,
			undefined,
			ctx,
		);
		assert.deepEqual(lastSelection?.ranges, [{ start: nearMax, end: Number.MAX_SAFE_INTEGER }]);

		const firstReadPage = textOf(await tool.execute("call-p1", { lines: "1-20" }, undefined, undefined, ctx));
		const readContMatch = /continue with (history:\/\/sessions\/s-cont\S+?)\]/.exec(firstReadPage);
		assert.ok(readContMatch, `expected read continuation URL in:\n${firstReadPage}`);
		const secondReadPage = textOf(
			await tool.execute("call-p2", { lines: readContMatch[1]! }, undefined, undefined, ctx),
		);
		assert.ok(secondReadPage.includes("entry-"), secondReadPage);

		const firstSearchPage = textOf(
			await tool.execute("call-s1", { pattern: "match-token" }, undefined, undefined, ctx),
		);
		assert.ok(firstSearchPage.includes("history://sessions/s-cont:1:"), firstSearchPage);
		assert.ok(!firstSearchPage.includes("history://sessions/s-cont:3:"), firstSearchPage);
		const searchContMatch = /continue with (history:\/\/sessions\/s-cont\?cursor=\S+?)\]/.exec(firstSearchPage);
		assert.ok(searchContMatch, `expected search continuation URL in:\n${firstSearchPage}`);

		const secondSearchPage = textOf(
			await tool.execute(
				"call-s2",
				{ pattern: "match-token", lines: searchContMatch[1]! },
				undefined,
				undefined,
				ctx,
			),
		);
		assert.ok(secondSearchPage.includes("history://sessions/s-cont:3:"), secondSearchPage);
		assert.ok(!secondSearchPage.includes("history://sessions/s-cont:1:"), secondSearchPage);
		assert.ok(!secondSearchPage.includes("foreign-session"), secondSearchPage);

		const longSearchEntries = Array.from({ length: 500 }, (_, i) =>
			userEntry(`ls-${i}`, i < 2 || i === 480 ? `entry-${i + 1} far-needle` : `entry-${i + 1} filler`, i),
		);
		const { router: longSearchRouter } = await createStoreWithSession("s-long-search", longSearchEntries, {
			rows: 10,
		});
		const longSearchTool = createSessionHistoryToolDefinition("session_history", {
			sessionId: () => "s-long-search",
			router: () => longSearchRouter,
		});
		const page1 = textOf(
			await longSearchTool.execute("call-ls1", { pattern: "far-needle" }, undefined, undefined, ctx),
		);
		const lsContMatch = /continue with (history:\/\/sessions\/s-long-search\?cursor=\S+?)\]/.exec(page1);
		assert.ok(lsContMatch, `expected search continuation URL in:\n${page1}`);
		assert.equal(lsContMatch[1], "history://sessions/s-long-search?cursor=11");
		const { router: fullLongSearchRouter } = await createStoreWithSession("s-long-search", longSearchEntries);
		const fullLongSearchTool = createSessionHistoryToolDefinition("session_history", {
			sessionId: () => "s-long-search",
			router: () => fullLongSearchRouter,
		});
		const page2 = textOf(
			await fullLongSearchTool.execute(
				"call-ls2",
				{ pattern: "far-needle", lines: lsContMatch[1]! },
				undefined,
				undefined,
				ctx,
			),
		);
		assert.ok(page2.includes("history://sessions/s-long-search:481:"), `expected entry 481 > 400 in:\n${page2}`);

		await assert.rejects(
			() =>
				tool.execute(
					"call-foreign",
					{ lines: "history://sessions/foreign-session:1-2" },
					undefined,
					undefined,
					ctx,
				),
			/Invalid lines|only this session/i,
		);
		await assert.rejects(
			() =>
				tool.execute(
					"call-project-all",
					{ lines: "history://sessions/s-cont?project=all:1-2" },
					undefined,
					undefined,
					ctx,
				),
			/Invalid lines|only \?cursor=/i,
		);
		await assert.rejects(
			() =>
				tool.execute(
					"call-overflow-cursor",
					{ lines: "history://sessions/s-cont?cursor=999999999999999999999:1-2" },
					undefined,
					undefined,
					ctx,
				),
			/Invalid lines|safe positive integers/i,
		);
	});
});
