import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	COMPACTION_RECALL_HEADING,
	COMPACTION_RECALL_MAX_TOKENS,
	COMPACTION_RECALL_TIME_LIMIT_MS,
	COMPACTION_RECALL_TOKEN_FRACTION,
	type HistoryRecallRequest,
	recallBudgetTokens,
	recallHistory,
	withRecalledContext,
} from "../src/core/compaction/history-recall.js";
import { createNumberedRegion } from "../src/core/compaction/transcript-serialization.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION } from "../src/core/storage/session/types.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import type { InternalResourceRouter, InternalSearchRequest } from "../src/core/tools/resource-selectors.js";

const SESSION_ID = "0198e0d1-2b3c-7abc-8def-123456789012";
const OWN = `history://sessions/${SESSION_ID}`;
const OTHER = "history://sessions/00000000-1111-7222-8333-444444444444";
const RUN = "history://workflows/run-1";
const QUERY = "Why does the zebra_cache_eviction regression return after the ttl_sweeper_v2 timer fires?";
const KEPT_TOKENS = 20_000;
const UNREACHED_TIME_LIMIT_MS = 120_000;

function row(source: string, line: number, text: string, kind: ":" | "-" = ":"): string {
	return `${source}${kind}${line}${kind} ${text}`;
}

function fakeRouter(
	outputs: Readonly<Record<string, string>>,
	seen: Array<{ url: string; request: InternalSearchRequest }> = [],
): InternalResourceRouter {
	return {
		search: async (url, request) => {
			seen.push({ url, request });
			return outputs[url] ?? "";
		},
	};
}

function request(router: InternalResourceRouter, overrides: Partial<HistoryRecallRequest> = {}): HistoryRecallRequest {
	return { router, sessionId: SESSION_ID, queries: [QUERY], keptLines: [], keptTokens: KEPT_TOKENS, ...overrides };
}

function sectionLines(section: string | undefined): string[] {
	assert.ok(section !== undefined, "expected a recalled section");
	return section.split("\n");
}

const FINDING = "Decision: the zebra_cache_eviction bug comes from the ttl_sweeper_v2 timer";
const OTHER_FINDING = "Earlier finding: ttl_sweeper_v2 evicts zebra_cache_eviction entries whenever the clock skews";

describe("recallBudgetTokens (#4568)", () => {
	it("is a small fraction of the kept size, capped (#4568)", () => {
		assert.equal(recallBudgetTokens(10_000), Math.floor(10_000 * COMPACTION_RECALL_TOKEN_FRACTION));
		assert.ok(COMPACTION_RECALL_TOKEN_FRACTION > 0 && COMPACTION_RECALL_TOKEN_FRACTION <= 0.25);
		assert.equal(recallBudgetTokens(1_000_000), COMPACTION_RECALL_MAX_TOKENS);
		assert.equal(recallBudgetTokens(0), 0);
		assert.ok(COMPACTION_RECALL_TIME_LIMIT_MS > 0);
	});
});

describe("recallHistory output (#4568)", () => {
	it("renders sourced, quoted snippets from this session and from other sources, best match first (#4568)", async () => {
		const router = fakeRouter({
			[OWN]: row(OWN, 12, FINDING),
			"history://": [row(OTHER, 7, OTHER_FINDING), row(RUN, 9, `error: ${FINDING}`)].join("\n"),
		});
		const section = await recallHistory(request(router));
		assert.deepEqual(sectionLines(section), [
			`${COMPACTION_RECALL_HEADING} (earlier lines matching this task; open a source with \`read\`):`,
			`${OWN}:12-12`,
			`> ${FINDING}`,
			`${RUN}:9-9`,
			`> error: ${FINDING}`,
			`${OTHER}:7-7`,
			`> ${OTHER_FINDING}`,
		]);
	});

	it("searches this session first, then the other sessions and runs, with a task-derived pattern (#4568)", async () => {
		const seen: Array<{ url: string; request: InternalSearchRequest }> = [];
		await recallHistory(
			request(fakeRouter({}, seen), {
				queries: ["fix src/net/socket.ts reconnect backoff", "Investigate the WebSocket ECONNRESET failure"],
			}),
		);
		assert.deepEqual(
			seen.map((call) => call.url),
			[OWN, "history://"],
		);
		for (const { request: search } of seen) {
			assert.equal(search.ignoreCase, true);
			assert.equal(search.literal, false);
			const alternatives = search.pattern.split("|");
			assert.ok(alternatives.length <= 12);
			assert.ok(alternatives.includes("src/net/socket\\.ts"), search.pattern);
			assert.ok(alternatives.includes("ECONNRESET"), search.pattern);
			assert.ok(alternatives.includes("reconnect"), search.pattern);
			assert.ok(alternatives.includes("backoff"), search.pattern);
			assert.ok(!alternatives.includes("the"));
			new RegExp(search.pattern, "i");
		}
		assert.equal(seen[0]?.request.pattern, seen[1]?.request.pattern);
	});

	it("ranks identifiers ahead of ordinary words when the task has many terms (#4568)", async () => {
		const words = Array.from({ length: 30 }, (_, index) =>
			`ordinaryword${"x".repeat(index)}`.replace(/\d/g, ""),
		).join(" ");
		const seen: Array<{ url: string; request: InternalSearchRequest }> = [];
		await recallHistory(request(fakeRouter({}, seen), { queries: [`${words} late_identifier_4568`] }));
		const alternatives = seen[0]?.request.pattern.split("|") ?? [];
		assert.equal(alternatives.length, 12);
		assert.equal(alternatives[0], "late_identifier_4568");
	});

	it("reads real search output, hyphenated and numeric ids included, through the history protocol (#4568)", async () => {
		const store = new MemorySessionStore();
		const header = (id: string, createdAt: string) => ({
			id,
			version: SESSION_FORMAT_VERSION,
			createdAt,
			cwd: "/project",
		});
		const entry = (id: string, text: string) => ({
			type: "message" as const,
			id,
			parentId: null,
			timestamp: "2026-10-01T00:00:00.000Z",
			message: { role: "user" as const, content: text, timestamp: 1 },
		});
		await store.create(header(SESSION_ID, "2026-10-03T00:00:00.000Z"), [entry("a", FINDING)]);
		await store.create(header("00000000-1111-7222-8333-444444444444", "2026-10-02T00:00:00.000Z"), [
			entry("b", "unrelated"),
			entry("c", OTHER_FINDING),
		]);
		const router = createHistoryRouter({
			cwd: "/project",
			currentSessionId: SESSION_ID,
			sessionStore: () => store,
			workflows: () => undefined,
		});
		const section = sectionLines(await recallHistory(request(router)));
		assert.ok(section.includes(`${OWN}:4-4`), section.join("\n"));
		assert.ok(section.includes(`> ${FINDING}`));
		assert.ok(section.includes(`${OTHER}:6-6`), section.join("\n"));
		assert.ok(section.includes(`> ${OTHER_FINDING}`));
	});

	it("merges consecutive matches into one range and keeps separate runs apart (#4568)", async () => {
		const router = fakeRouter({
			[OWN]: [
				row(OWN, 20, "first zebra_cache_eviction note"),
				row(OWN, 21, "second ttl_sweeper_v2 note"),
				row(OWN, 40, "later zebra_cache_eviction and ttl_sweeper_v2 note"),
			].join("\n"),
		});
		const lines = sectionLines(await recallHistory(request(router)));
		assert.ok(lines.includes(`${OWN}:20-21`), lines.join("\n"));
		assert.ok(lines.includes(`${OWN}:40-40`), lines.join("\n"));
	});

	it("leaves out weak matches, headings, tool calls and its own earlier sections (#4568)", async () => {
		const router = fakeRouter({
			[OWN]: [
				row(OWN, 3, "regression"),
				row(OWN, 4, "## 2026-10-01T00:00:00.000Z assistant"),
				row(OWN, 5, "# session abc zebra_cache_eviction ttl_sweeper_v2"),
				row(OWN, 7, '[tool call] read {"path":"zebra_cache_eviction","note":"ttl_sweeper_v2"}'),
				row(OWN, 9, `${COMPACTION_RECALL_HEADING} (zebra_cache_eviction ttl_sweeper_v2)`),
				row(OWN, 10, "history://sessions/abc:3-4"),
				"history://sessions?offset=25:0: [searched sessions 1-25 of 40; continue with history://sessions?offset=25]",
			].join("\n"),
		});
		assert.equal(await recallHistory(request(router)), undefined);
	});
});

describe("recallHistory never repeats a line (#4568)", () => {
	it("drops lines the compacted context keeps, whatever their role header, quote or spacing (#4568)", async () => {
		const router = fakeRouter({
			[OWN]: [
				row(OWN, 5, FINDING),
				row(OWN, 6, `  ${OTHER_FINDING}  `),
				row(OWN, 7, "the zebra_cache_eviction timer ttl_sweeper_v2 stays unique"),
			].join("\n"),
		});
		const section = await recallHistory(
			request(router, {
				keptLines: [`[User]: ${FINDING}`, `> ${OTHER_FINDING.replace(/ /g, "  ")}`, "(filtered 2 lines)"],
			}),
		);
		assert.deepEqual(sectionLines(section).slice(1), [
			`${OWN}:7-7`,
			"> the zebra_cache_eviction timer ttl_sweeper_v2 stays unique",
		]);
	});

	it("drops a line the search cut at its length limit when the kept line starts the same way (#4568)", async () => {
		const longLine = `zebra_cache_eviction ttl_sweeper_v2 ${"stack frame ".repeat(80)}`;
		const cut = `${longLine.slice(0, 512)}… [truncated]`;
		const router = fakeRouter({ [OWN]: row(OWN, 5, cut) });
		assert.equal(await recallHistory(request(router, { keptLines: [longLine] })), undefined);
		assert.ok(await recallHistory(request(router, { keptLines: ["something else"] })));
	});

	it("shows a line once when the same text arrives from several sources or twice from one (#4568)", async () => {
		const router = fakeRouter({
			[OWN]: [row(OWN, 5, FINDING), row(OWN, 30, `> ${FINDING}`)].join("\n"),
			"history://": [row(OTHER, 2, FINDING), row(RUN, 4, FINDING), row(OWN, 5, FINDING)].join("\n"),
		});
		const lines = sectionLines(await recallHistory(request(router)));
		assert.equal(lines.filter((line) => line === `> ${FINDING}`).length, 1, lines.join("\n"));
		assert.deepEqual(lines.slice(1), [`${OWN}:5-5`, `> ${FINDING}`]);
	});

	it("splits a snippet around a line that is already kept, so each range names only what it shows (#4568)", async () => {
		const router = fakeRouter({
			[OWN]: [
				row(OWN, 10, "zebra_cache_eviction regression first part"),
				row(OWN, 11, "kept middle ttl_sweeper_v2"),
				row(OWN, 12, "ttl_sweeper_v2 regression last part"),
			].join("\n"),
		});
		const lines = sectionLines(await recallHistory(request(router, { keptLines: ["kept middle ttl_sweeper_v2"] })));
		assert.ok(!lines.some((line) => line.includes("kept middle")));
		assert.deepEqual(
			lines.filter((line) => line.startsWith("history://")),
			[`${OWN}:10-10`, `${OWN}:12-12`],
		);
	});
});

describe("recallHistory respects the token budget (#4568)", () => {
	function manyMatches(count: number): string {
		return Array.from({ length: count }, (_, index) =>
			row(OWN, 10 + index * 3, `finding ${index}: zebra_cache_eviction with ttl_sweeper_v2 ${"detail ".repeat(30)}`),
		).join("\n");
	}

	it("never adds more tokens than the budget for the kept size (#4568)", async () => {
		const router = fakeRouter({ [OWN]: manyMatches(80) });
		for (const keptTokens of [3_000, 10_000, 40_000, 1_000_000]) {
			const section = await recallHistory(request(router, { keptTokens }));
			assert.ok(section !== undefined, `kept ${keptTokens}`);
			const added = Math.ceil(withRecalledContext("", section).length / 4);
			assert.ok(
				added <= recallBudgetTokens(keptTokens),
				`kept ${keptTokens}: ${added} > ${recallBudgetTokens(keptTokens)}`,
			);
		}
	});

	it("grows with the kept size up to the absolute cap (#4568)", async () => {
		const router = fakeRouter({ [OWN]: manyMatches(80) });
		const size = async (keptTokens: number): Promise<number> =>
			(await recallHistory(request(router, { keptTokens })))?.length ?? 0;
		assert.ok((await size(3_000)) < (await size(10_000)));
		assert.ok((await size(10_000)) < (await size(40_000)));
		assert.equal(await size(40_000), await size(4_000_000));
		assert.ok(Math.ceil((await size(4_000_000)) / 4) <= COMPACTION_RECALL_MAX_TOKENS);
	});

	it("keeps the best-scoring snippets when not everything fits (#4568)", async () => {
		const strong = "zebra_cache_eviction ttl_sweeper_v2 regression timer";
		const router = fakeRouter({
			[OWN]: [
				row(OWN, 3, `weak: zebra_cache_eviction ${"padding ".repeat(30)}regression`),
				row(OWN, 30, `${strong} ${"padding ".repeat(30)}`),
			].join("\n"),
		});
		const lines = sectionLines(await recallHistory(request(router, { keptTokens: 1_400 })));
		assert.ok(
			lines.some((line) => line.startsWith(`> ${strong}`)),
			lines.join("\n"),
		);
		assert.ok(!lines.some((line) => line.startsWith("> weak")), lines.join("\n"));
	});

	it("adds nothing when even one snippet does not fit (#4568)", async () => {
		const router = fakeRouter({ [OWN]: row(OWN, 5, FINDING) });
		assert.equal(await recallHistory(request(router, { keptTokens: 100 })), undefined);
		assert.equal(await recallHistory(request(router, { keptTokens: 0 })), undefined);
	});
});

describe("recallHistory is skipped, never failing, when recall cannot run (#4568)", () => {
	it("is skipped when a search rejects or throws (#4568)", async () => {
		const rejecting: InternalResourceRouter = {
			search: async (url) => {
				if (url === "history://") throw new Error("both halves failed");
				return row(OWN, 5, FINDING);
			},
		};
		assert.equal(await recallHistory(request(rejecting)), undefined);
		const throwing: InternalResourceRouter = {
			search: () => {
				throw new Error("synchronous failure");
			},
		};
		assert.equal(await recallHistory(request(throwing)), undefined);
		const failingOwn: InternalResourceRouter = {
			search: async (url) => {
				if (url === OWN) throw new Error("session not found");
				return row(OTHER, 2, OTHER_FINDING);
			},
		};
		assert.equal(await recallHistory(request(failingOwn)), undefined);
	});

	it("is skipped when the search outlasts the time limit, however it stalls (#4568)", async () => {
		const never: InternalResourceRouter = { search: () => new Promise<string>(() => {}) };
		assert.equal(await recallHistory(request(never, { timeLimitMs: 15 })), undefined);

		const slow: InternalResourceRouter = {
			search: () => new Promise<string>((resolve) => setTimeout(() => resolve(row(OWN, 5, FINDING)), 200)),
		};
		assert.equal(await recallHistory(request(slow, { timeLimitMs: 15 })), undefined);

		const blocking: InternalResourceRouter = {
			search: async () => {
				const until = Date.now() + 40;
				while (Date.now() < until) {}
				return row(OWN, 5, FINDING);
			},
		};
		assert.equal(await recallHistory(request(blocking, { timeLimitMs: 15 })), undefined);
		assert.ok(await recallHistory(request(blocking, { timeLimitMs: 5_000 })), "the same router fits a roomy limit");
	});

	it("is skipped when compaction is cancelled before or during the search (#4568)", async () => {
		let called = 0;
		const counting: InternalResourceRouter = {
			search: async () => {
				called++;
				return row(OWN, 5, FINDING);
			},
		};
		const early = new AbortController();
		early.abort();
		assert.equal(await recallHistory(request(counting, { signal: early.signal })), undefined);
		assert.equal(called, 0, "a cancelled compaction searches nothing");

		const during = new AbortController();
		const pending: InternalResourceRouter = {
			search: () => {
				queueMicrotask(() => during.abort());
				return new Promise<string>(() => {});
			},
		};
		assert.equal(
			await recallHistory(request(pending, { signal: during.signal, timeLimitMs: UNREACHED_TIME_LIMIT_MS })),
			undefined,
		);

		const synchronously = new AbortController();
		const abortsInsideSearch: InternalResourceRouter = {
			search: () => {
				synchronously.abort();
				return new Promise<string>(() => {});
			},
		};
		assert.equal(
			await recallHistory(
				request(abortsInsideSearch, { signal: synchronously.signal, timeLimitMs: UNREACHED_TIME_LIMIT_MS }),
			),
			undefined,
		);
	});

	it("is skipped when nothing matches (#4568)", async () => {
		assert.equal(await recallHistory(request(fakeRouter({}))), undefined);
		assert.equal(await recallHistory(request({ search: async () => undefined })), undefined);
		assert.equal(await recallHistory(request({})), undefined, "a router that cannot search");
	});

	it("is skipped, without searching, when the task has no usable terms (#4568)", async () => {
		let called = 0;
		const counting: InternalResourceRouter = {
			search: async () => {
				called++;
				return row(OWN, 5, FINDING);
			},
		};
		for (const queries of [[], ["the latest user request"], ["do that now, please"], ["", "   "]]) {
			assert.equal(await recallHistory(request(counting, { queries })), undefined, JSON.stringify(queries));
		}
		assert.equal(called, 0);
	});
});

describe("recalled text cannot act as compaction structure (#4568)", () => {
	it("quotes every line so tags, role headers and markers stay inert on the next pass (#4568)", async () => {
		const router = fakeRouter({
			[OWN]: [
				row(OWN, 3, "[User]: zebra_cache_eviction ttl_sweeper_v2"),
				row(OWN, 4, "<keepContext>"),
				row(OWN, 5, "(filtered 2 lines)"),
				row(OWN, 6, "[Assistant]: ttl_sweeper_v2 zebra_cache_eviction"),
				row(OWN, 7, "</keepContext>"),
			].join("\n"),
		});
		const section = await recallHistory(request(router));
		assert.ok(section !== undefined);
		const region = createNumberedRegion(withRecalledContext("[User]: kept\nplain text", section));
		assert.equal(region.protectedLineNumbers, undefined, "no <keepContext> span armed");
		assert.deepEqual([...region.headerLineNumbers], [1], "only the real role header counts");
		assert.equal(region.priorMarkerNs.size, 0, "no filtered marker was forged");
		for (const line of section.split("\n").slice(2)) assert.ok(line.startsWith("> ") || line === ">", line);
	});
});

describe("withRecalledContext (#4568)", () => {
	it("separates the section from the compacted text by a blank line (#4568)", () => {
		assert.equal(withRecalledContext("kept", "Recalled context"), "kept\n\nRecalled context");
	});
});
