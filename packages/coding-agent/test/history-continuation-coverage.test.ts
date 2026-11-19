import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import type { WorkflowRunDetail, WorkflowRunSummary } from "../src/core/extensions/workflow-run-control.js";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION } from "../src/core/storage/session/types.js";
import { createHistoryRouter, type WorkflowRunHistory } from "../src/core/tools/history-protocol.js";
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

const summary = (runId: string, startedAt: number): WorkflowRunSummary => ({
	runId,
	name: `flow ${runId}`,
	status: "completed",
	startedAt,
	elapsedMs: 1,
	activeStages: [],
	awaitingInput: [],
	awaitingInputCount: 0,
});
const detail = (runId: string, startedAt: number): WorkflowRunDetail => ({
	runId,
	name: `flow ${runId}`,
	status: "completed",
	startedAt,
	endedAt: startedAt + 1,
	summary: `needle ${runId}`,
	inputs: {},
	stages: [],
});

describe("history:// continuation chains cover each entry once", () => {
	for (const first of ["history://sessions?limit=2", "history://sessions"]) {
		it(`a session the chain has not reached yet that gets new activity is still searched, once (${first})`, async () => {
			const store = new MemorySessionStore();
			for (let n = 1; n <= 6; n++) await addSession(store, `s${n}`, BASE + n * 60_000, [`needle s${n}`]);
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => store,
				workflows: () => undefined,
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
		const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => undefined });
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
		const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => undefined });
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
			const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => undefined });
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

	it.each(["sessions", "workflows"] as const)(
		"read of a printed %s cursor still fits the listing's own budget",
		async (domain) => {
			const store = new MemorySessionStore();
			const at = 1_700_000_000_000;
			for (let i = 0; i < 3; i++) await addSession(store, `s${i}`, at - i, ["needle"]);
			const workflows: WorkflowRunHistory = {
				listRuns: async () => [0, 1, 2].map((i) => ({ ...summary(`r${i}`, at - i), name: "n".repeat(160) })),
				getRun: async (id) => ({ ...detail(id, at), name: "needle", summary: "x" }),
			};
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => store,
				workflows: () => workflows,
				budget: { bytes: domain === "sessions" ? 245 : 222 },
			});
			const first = (await router.search!(`history://${domain}?limit=1`, request("needle")))!;
			const next = continuation(first)!;
			const pin = domain === "sessions" ? `after=${at}.${at}.s0` : "run=r1";
			const expected = `history://${domain}?offset=1&limit=1&${pin}`;
			const read = await router.read!(next);
			assert.equal(read, await router.read!(expected));
			assert.ok(read?.includes(`continue with ${expected}&cursor=2:2-2]`), read);
		},
	);

	it("an unchanged early workflow page and a skipped selector do not need an off-page shard", async () => {
		let farthest = 1;
		const workflows: WorkflowRunHistory = {
			listRuns: async () =>
				Array.from({ length: 4_096 }, (_, i) => ({
					...summary(`r${i}`, BASE - i),
					get runId() {
						if (i > farthest) throw new Error("unrelated shard closed");
						return `r${i}`;
					},
				})),
			getRun: async (id) => detail(id, BASE),
		};
		const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => undefined, workflows: () => workflows });
		const tool = createSearchToolDefinition(PROJECT, { contextBefore: 0, contextAfter: 0 });
		const path = "history://workflows?limit=1";
		const skipped = await tool.execute("skip", { pattern: "needle", paths: path, skip: 1000 }, undefined, undefined, {
			cwd: PROJECT,
			internalResourceRouter: router,
		} as never);
		assert.deepEqual(skipped.content, [{ type: "text", text: "No more results (skip=1000)" }]);
		const next = continuation((await router.search!(path, request("needle")))!)!;
		farthest = 2;
		assert.match((await router.search!(next, request("needle")))!, /summary: needle r1$/m);
	});

	it("finishing a workflow search releases its listing while the sessions half of a root search waits", async () => {
		const release = Promise.withResolvers<void>();
		const lastDetail = Promise.withResolvers<void>();
		const refs: WeakRef<WorkflowRunSummary>[] = [];
		class WaitingStore extends MemorySessionStore {
			override async *list(...args: Parameters<MemorySessionStore["list"]>) {
				await release.promise;
				yield* super.list(...args);
			}
		}
		const store = new WaitingStore();
		const workflows: WorkflowRunHistory = {
			listRuns: async () =>
				Array.from({ length: 4 }, (_, i) => {
					const run = summary(`r${i}`, BASE - i);
					refs.push(new WeakRef(run));
					return run;
				}),
			getRun: async (id) => {
				if (id === "r1") lastDetail.resolve();
				return detail(id, BASE);
			},
		};
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			workflows: () => workflows,
			budget: { timeMs: 30_000 },
		});
		const search = router.search!("history://?limit=2", request("needle"));
		try {
			await lastDetail.promise;
			await new Promise<void>((done) => setImmediate(done));
			const bun = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun;
			if (bun)
				for (let i = 0; i < 10; i++) {
					bun.gc(true);
					await new Promise<void>((done) => setTimeout(done, 10));
				}
			else await (await import("../../../test/helpers/collect-garbage.js")).collectGarbage();
			assert.equal(refs.filter((ref) => ref.deref()).length, 0);
		} finally {
			release.resolve();
			await search;
			await store.close();
		}
	});

	it("direct and already-cancelled workflow searches don't need an unrelated session's identity", async () => {
		let calls = 0;
		const router = createHistoryRouter({
			cwd: PROJECT,
			get currentSessionId(): string {
				throw new Error("unrelated session unavailable");
			},
			sessionStore: () => undefined,
			workflows: () => {
				calls++;
				return { listRuns: async () => [summary("one", BASE)], getRun: async () => detail("one", BASE) };
			},
		});
		const reason = new Error("cancelled");
		await assert.rejects(
			router.search!("history://workflows/one", { ...request("needle"), signal: AbortSignal.abort(reason) }),
			(error) => error === reason,
		);
		const cancelled = { ...request("needle"), signal: AbortSignal.abort(reason) };
		await assert.rejects(router.search!("history://workflows?p=bad", cancelled), (error) => error === reason);
		await assert.rejects(router.search!("history://workflows?limit=0", cancelled), /history limit must be/);
		assert.equal(calls, 0);
		assert.match((await router.search!("history://workflows/one", request("needle")))!, /summary: needle one/);
	});

	it("an abandoned chain does not need its original router or a free slot in a process cache", async () => {
		const store = new MemorySessionStore();
		for (let i = 0; i < 4; i++) await addSession(store, `s${i}`, BASE + i, [`needle s${i}`]);
		const open = () => createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => undefined });
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
		const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => undefined });
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

	it("removing the pin does not bring back tied runs excluded by the initial offset", async () => {
		const runs = ["r6", "r5", "r4", "r3", "r2", "r1"];
		const workflows: WorkflowRunHistory = {
			listRuns: async () => runs.map((id) => summary(id, BASE)),
			getRun: async (id) => detail(id, BASE),
		};
		const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => undefined, workflows: () => workflows });
		const first = (await router.search!("history://workflows?offset=2&limit=2", request("needle")))!;
		const next = continuation(first)!;
		runs.splice(runs.indexOf("r2"), 1);
		const second = (await router.search!(next, request("needle")))!;
		assert.deepEqual(
			[...second.matchAll(/summary: needle (r\d)/g)].map((hit) => hit[1]),
			["r1"],
			second,
		);
		assert.equal(continuation(second), undefined);
	});

	for (const change of [
		"the run it resumes at and a run it searched are removed",
		"the run it resumes at is removed and a run starts",
	] as const) {
		it(`a workflow search chain covers every run once when ${change}`, async () => {
			const runs = new Map<string, number>();
			for (let n = 1; n <= 5; n++) runs.set(`r${n}`, BASE + n * 60_000);
			const control: WorkflowRunHistory = {
				listRuns: async () => [...runs].map(([id, at]) => summary(id, at)),
				listProjectRuns: async () => [...runs].map(([id, at]) => summary(id, at)),
				getRun: async (id) => detail(id, runs.get(id) ?? BASE),
			};
			const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => undefined, workflows: () => control });
			const outputs: string[] = [];
			let url: string | undefined = "history://workflows?limit=2";
			let changed = false;
			for (let call = 0; url !== undefined && call < 20; call++) {
				const out = (await router.search!(url, request("needle"))) ?? "";
				outputs.push(out);
				if (!changed) {
					changed = true;
					runs.delete("r3");
					if (change.includes("searched")) runs.delete("r5");
					else runs.set("r6", BASE + 100 * 60_000);
				}
				url = continuation(out);
			}
			const rows = outputs.flatMap((out) => [...out.matchAll(/summary: (needle r\d)$/gm)].map((match) => match[1]!));
			assert.deepEqual(
				rows.filter((row, index) => rows.indexOf(row) !== index),
				[],
				outputs.join("\n---\n"),
			);
			assert.deepEqual(
				[...new Set(rows)].filter((row) => row !== "needle r3").sort(),
				["needle r1", "needle r2", "needle r4", "needle r5"],
				outputs.join("\n---\n"),
			);
		});
	}
});
