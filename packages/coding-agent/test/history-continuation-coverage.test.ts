import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION, type SessionStore } from "../src/core/storage/session/types.js";
import { AgentTaskHost } from "../src/core/tasks/agent-adapter.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import type { InternalResourceRouter, InternalSearchRequest } from "../src/core/tools/resource-selectors.js";
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

function ownedSearch(cwd: string) {
	const owner = new AgentTaskHost({
		scope: { kind: "session", sessionId: crypto.randomUUID() },
		authorizeLaunch() {},
	});
	const tool = createSearchToolDefinition(cwd, { taskOwner: owner.ownerBinding, contextBefore: 0, contextAfter: 0 });
	return {
		owner,
		async launch(router: InternalResourceRouter) {
			const ctx = { cwd, internalResourceRouter: router } as never;
			const result = await tool.execute(
				"launch",
				{ pattern: "needle", paths: "history://sessions", wait: { kind: "background" } },
				undefined,
				undefined,
				ctx,
			);
			const { observation } = result.details as { observation: { kind: string; taskId: string } };
			assert.equal(observation.kind, "yielded");
			return async () => {
				const waited = await tool.execute(
					"wait",
					{ action: "wait", id: observation.taskId, budgetMs: 20_000 },
					undefined,
					undefined,
					ctx,
				);
				return waited.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
			};
		},
	};
}

describe("history:// continuation chains cover each entry once", () => {
	for (const first of ["history://sessions/s1", "history://sessions"]) {
		it(`a store wait right after a mid-entry stop keeps the match position (${first})`, async () => {
			const store = new MemorySessionStore();
			const lines = Array.from(
				{ length: 6 },
				(_, i) => `needle ${String.fromCharCode(97 + i)} ${"x".repeat(60)}`,
			).join("\n");
			await store.create(
				{ id: "s1", version: SESSION_FORMAT_VERSION, createdAt: new Date(BASE).toISOString(), cwd: PROJECT },
				[message("s1-e1", lines, BASE), message("s1-e2", "nothing", BASE + 1)],
			);
			let slow = false;
			const sessions = new Proxy(store, {
				get(target, key) {
					if (key === "readEntryRange")
						return async (...args: Parameters<MemorySessionStore["readEntryRange"]>) => {
							const [, query] = args;
							if (slow && query.toSeq >= query.fromSeq) await new Promise((done) => setTimeout(done, 600));
							return target.readEntryRange(...args);
						};
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => sessions,
				workflows: () => undefined,
				budget: { bytes: 700, timeMs: 40 },
			});
			const urls: string[] = [];
			const outputs: string[] = [];
			let url: string | undefined = first;
			for (let call = 0; url !== undefined && call < 20; call++) {
				urls.push(url);
				// The first call that resumes mid-entry meets a slow store.
				slow = /cursor=1\.\d/.test(url) && !urls.slice(0, -1).includes(url);
				const out = (await router.search!(url, request("needle"))) ?? "";
				outputs.push(out);
				url = continuation(out);
			}
			const rows = outputs.flatMap((out) => [...out.matchAll(/: (needle [a-f])/gm)].map((match) => match[1]!));
			assert.deepEqual(
				rows.filter((row, index) => rows.indexOf(row) !== index),
				[],
				`repeated:\n${urls.join("\n")}\n---\n${outputs.join("\n---\n")}`,
			);
			assert.deepEqual([...rows].sort(), ["needle a", "needle b", "needle c", "needle d", "needle e", "needle f"]);
		});
	}

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

	it("more chains than the store parks listings for each still finish listing the sessions", async () => {
		const store = new MemorySessionStore();
		for (let n = 1; n <= 3; n++)
			await store.create(
				{ id: `s${n}`, version: SESSION_FORMAT_VERSION, createdAt: new Date(BASE + n).toISOString(), cwd: PROJECT },
				[message(`s${n}-e1`, `needle s${n}`, BASE + n)],
			);
		// One session per call: each chain's listing stops, and is parked, after every session it reads.
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			workflows: () => undefined,
			budget: { rows: 1 },
		});
		const chains = 17;
		const { owner, launch } = ownedSearch(PROJECT);
		const barrier = Promise.withResolvers<void>();
		try {
			const waits = await Promise.all(
				Array.from({ length: chains }, () =>
					launch({
						search: async (url, q) => {
							if (url !== "history://sessions") await barrier.promise;
							return router.search!(url, q);
						},
					}),
				),
			);
			barrier.resolve();
			const listed = await Promise.all(waits.map((wait) => wait()));
			assert.equal(listed.length, chains);
			for (const out of listed)
				for (const id of ["s1", "s2", "s3"])
					assert.match(out, new RegExp(`history://sessions/${id}:1: needle ${id}\\b`));
		} finally {
			barrier.resolve();
			await owner.close("session-close");
		}
	});

	it("a chain never adopts a session listing another chain started before a session was created", async () => {
		const dir = mkdtempSync(join(tmpdir(), "history-chain-listing-"));
		const project = mkdtempSync(join(tmpdir(), "history-chain-project-"));
		const database = await openNodeSqliteDatabase(join(dir, "sessions.sqlite"));
		const store = await SqlSessionStore.open(database);
		const { owner, launch } = ownedSearch(project);
		try {
			const add = (id: string, at: number) =>
				store.create({ id, version: SESSION_FORMAT_VERSION, createdAt: new Date(at).toISOString(), cwd: project }, [
					message(`${id}-e1`, `needle ${id}`, at),
				]);
			for (let n = 1; n <= 4; n++) await add(`s${n}`, BASE + n * 60_000);
			const gate = () => {
				let open = () => {};
				const opened = new Promise<void>((done) => {
					open = done;
				});
				return { opened, open };
			};
			// Per listing, in the order the listings start: before which item it waits, until released.
			const holds: Map<number, ReturnType<typeof gate>>[] = [];
			let listings = 0;
			const sessions = new Proxy(store, {
				get(target, key) {
					if (key === "list")
						return (query: Parameters<SessionStore["list"]>[0]) => {
							const serial = listings++;
							holds[serial] ??= new Map();
							const mine = holds[serial]!;
							return (async function* () {
								let index = 0;
								for await (const listed of target.list(query)) {
									const hold = mine.get(index);
									if (hold) await hold.opened;
									index++;
									yield listed;
								}
							})();
						};
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}) as SessionStore;
			const router = createHistoryRouter({
				cwd: project,
				sessionStore: () => sessions,
				workflows: () => undefined,
				budget: { timeMs: 40 },
			});
			const aResume = gate(),
				bResume = gate(),
				aAdvanced = gate();
			const gated = (
				resume: ReturnType<typeof gate>,
				advanced?: ReturnType<typeof gate>,
			): InternalResourceRouter => ({
				search: async (url, q) => {
					if (url !== "history://sessions") await resume.opened;
					const result = await router.search!(url, { ...q, timeBudgetMs: 40 });
					if (url !== "history://sessions") advanced?.open();
					return result;
				},
			});
			// Chain A: its listing waits before item 1.
			holds[0] = new Map([[1, gate()]]);
			const waitA = await launch(gated(aResume, aAdvanced));
			// A session is created after chain A started and before chain B starts.
			await add("x", BASE + 100 * 60_000);
			// Chain B: its own listing waits before item 2.
			holds[1] = new Map([[2, gate()]]);
			const waitB = await launch(gated(bResume));
			// Chain A goes on: its listing moves one item on and waits before item 2.
			holds[0]!.set(2, gate());
			holds[0]!.get(1)!.open();
			aResume.open();
			await aAdvanced.opened;
			for (const hold of holds) for (const opened of hold?.values() ?? []) opened.open();
			bResume.open();
			const [, out] = await Promise.all([waitA(), waitB()]);
			const rows = [...out.matchAll(/: (needle \w+)$/gm)].map((match) => match[1]!);
			assert.deepEqual([...rows].sort(), ["needle s1", "needle s2", "needle s3", "needle s4", "needle x"]);
		} finally {
			await owner.close("session-close");
			await store.close();
			await database.close();
			rmSync(dir, { recursive: true, force: true });
			rmSync(project, { recursive: true, force: true });
		}
	});
});
