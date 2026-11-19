import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it, vi } from "vitest";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION } from "../src/core/storage/session/types.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import type { InternalSearchRequest } from "../src/core/tools/resource-selectors.js";

const RUNAWAY = "a".repeat(35);

vi.mock("../src/core/tools/history-regex-worker.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/core/tools/history-regex-worker.js")>();
	return {
		...original,
		matchLinesInWorker: async (
			lines: readonly string[],
			pattern: string,
			flags: string,
			ignoreCase: boolean,
			literal: boolean,
			budgetMs: number,
			signal?: AbortSignal,
		) =>
			lines.some((line) => line.includes(RUNAWAY))
				? { matchedIndices: [], timedOut: true }
				: original.matchLinesInWorker(lines, pattern, flags, ignoreCase, literal, budgetMs, signal),
	};
});

const PROJECT = resolve("/projects/history-stop-notes");
const BASE = Date.parse("2026-11-01T00:00:00.000Z");

function request(pattern: string): InternalSearchRequest {
	return { pattern, ignoreCase: false, literal: false, contextBefore: 0, contextAfter: 0 };
}

function continuation(text: string): string | undefined {
	return /continue with (history:\/\/\S+?)\]?$/m.exec(text)?.[1];
}

async function addSession(store: MemorySessionStore, id: string, at: number, texts: readonly string[]): Promise<void> {
	await store.create(
		{ id, version: SESSION_FORMAT_VERSION, createdAt: new Date(at).toISOString(), cwd: PROJECT },
		texts.map((text, index) => ({
			type: "message" as const,
			id: `${id}-e${index + 1}`,
			parentId: null,
			timestamp: new Date(at + index).toISOString(),
			message: { role: "user" as const, content: text, timestamp: at + index },
		})),
	);
}

function failOnSessions(store: MemorySessionStore, failingIds: ReadonlySet<string>): MemorySessionStore {
	return new Proxy(store, {
		get(target, key) {
			if (key === "readEntryRange") {
				return async (sessionId: string, query: Parameters<MemorySessionStore["readEntryRange"]>[1]) => {
					if (failingIds.has(sessionId)) throw new Error(`corrupt ${sessionId}`);
					return target.readEntryRange(sessionId, query);
				};
			}
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

describe("history:// stop and skipped-entry notes under tight budgets (#5250)", () => {
	it("a cut match in the final session reports the byte stop without an empty continuation (#5250)", async () => {
		for (const count of [1, 2]) {
			const store = new MemorySessionStore();
			try {
				if (count === 2) await addSession(store, "s0", BASE + 1_000, ["nothing here"]);
				await addSession(store, "s1", BASE, [`needle ${"x".repeat(1_000)}`]);
				const completeRouter = createHistoryRouter({
					cwd: PROJECT,
					sessionStore: () => store,
				});
				const url = count === 1 ? "history://sessions" : "history://sessions?offset=1";
				const complete = (await completeRouter.search!(url, request("needle"))) ?? "";
				let cutPages = 0;
				for (let bytes = 220; bytes <= 700; bytes += 9) {
					const router = createHistoryRouter({
						cwd: PROJECT,
						sessionStore: () => store,
						budget: { bytes },
					});
					const output = (await router.search!(url, request("needle"))) ?? "";
					if (output === complete) continue;
					assert.match(output, /history:\/\/sessions\/s1:1: needle/);
					cutPages++;
					assert.ok(Buffer.byteLength(output) <= bytes, `${bytes}: ${output}`);
					assert.ok(
						output
							.split("\n")
							.includes(`${url}:0: [searched sessions ${count}-${count} of ${count}; the byte budget ran out]`),
						`${bytes}: ${output}`,
					);
					assert.equal(continuation(output), undefined, output);
				}
				assert.ok(cutPages > 0);
			} finally {
				await store.close();
			}
		}
	});

	it("a session search that exhausts its row budget between sessions reports the row stop reason (#5250)", async () => {
		const store = new MemorySessionStore();
		await addSession(store, "s1", BASE + 2_000, ["unreadable first"]);
		await addSession(store, "s2", BASE + 1_000, ["needle first"]);
		await addSession(store, "s3", BASE, ["needle second"]);
		const failingStore = failOnSessions(store, new Set(["s1"]));
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => failingStore,
			budget: { rows: 4 },
		});
		const first = (await router.search!("history://sessions", request("needle"))) ?? "";
		assert.match(
			first,
			/^history:\/\/sessions:0: \[searched sessions 1-2 of 3, 1 unreadable; the row budget ran out; continue with (history:\/\/sessions\?offset=2&after=\S+)\]$/m,
		);
		assert.ok(first.split("\n").includes("history://sessions/s2:1: needle first"), first);
		const next = continuation(first);
		assert.ok(next, first);
		const second = (await router.search!(next, request("needle"))) ?? "";
		assert.ok(second.split("\n").includes("history://sessions/s3:1: needle second"), second);
		await store.close();
	});

	it("a session search trimmed back to fit its byte budget preserves the unreadable count through the kept session (#5250)", async () => {
		const store = new MemorySessionStore();
		await addSession(store, "s1", BASE + 3_000, ["unreadable first"]);
		await addSession(store, "s2", BASE + 2_000, [`needle ${"b".repeat(185)}`]);
		await addSession(store, "s3", BASE + 1_000, ["unreadable third"]);
		await addSession(store, "s4", BASE, [`needle ${"d".repeat(195)}`]);
		const failingStore = failOnSessions(store, new Set(["s1", "s3"]));
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => failingStore,
			budget: { bytes: 500 },
		});
		const first = (await router.search!("history://sessions", request("needle"))) ?? "";
		assert.ok(Buffer.byteLength(first) <= 500, `${Buffer.byteLength(first)}: ${first}`);
		assert.match(
			first,
			/^history:\/\/sessions:0: \[searched sessions 1-3 of 4, 2 unreadable; the byte budget ran out; continue with history:\/\/sessions\?offset=3&after=\S+\]$/m,
		);
		assert.ok(first.split("\n").includes(`history://sessions/s2:1: needle ${"b".repeat(185)}`), first);
		assert.ok(!first.includes("history://sessions/s4:"), first);
		const next = continuation(first);
		assert.ok(next, first);
		const second = (await router.search!(next, request("needle"))) ?? "";
		assert.ok(Buffer.byteLength(second) <= 500, `${Buffer.byteLength(second)}: ${second}`);
		assert.ok(second.split("\n").includes(`history://sessions/s4:1: needle ${"d".repeat(195)}`), second);
		await store.close();

		const checkpointStore = new MemorySessionStore();
		await addSession(checkpointStore, "c1", BASE + 1_000, ["unreadable first"]);
		await addSession(checkpointStore, "c2", BASE, [`needle ${"b".repeat(190)}`, `needle ${"c".repeat(200)}`]);
		const checkpointRouter = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => failOnSessions(checkpointStore, new Set(["c1"])),
			budget: { bytes: 500 },
		});
		const trimmedCheckpoint = (await checkpointRouter.search!("history://sessions", request("needle"))) ?? "";
		assert.ok(
			Buffer.byteLength(trimmedCheckpoint) <= 500,
			`${Buffer.byteLength(trimmedCheckpoint)}: ${trimmedCheckpoint}`,
		);
		assert.match(
			trimmedCheckpoint,
			/^history:\/\/sessions:0: \[searched sessions 1-2 of 2, 1 unreadable; the byte budget ran out at entry 2 of 2 in history:\/\/sessions\/c2; continue with history:\/\/sessions\?offset=1&session=c2&cursor=2&after=\S+\]$/m,
		);
		await checkpointStore.close();
	});

	it("a session search that cuts its first match row alongside a fixed note fits its byte budget and keeps the note (#5250)", async () => {
		const store = new MemorySessionStore();
		const fullText = `needle one ${"y".repeat(600)}`;
		const fullRow = `history://sessions/s1:1: ${fullText}`;
		await addSession(store, "s1", BASE, [fullText, "needle two"]);
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			budget: { bytes: 500 },
		});
		const output = (await router.search!("history://sessions?session=vanished&cursor=1", request("needle"))) ?? "";
		assert.ok(Buffer.byteLength(output) <= 500, `${Buffer.byteLength(output)}: ${output}`);
		const lines = output.split("\n");
		assert.ok(
			lines.includes(
				"history://sessions:0: [session vanished is no longer listed, so the search could not resume in it; it continued with the sessions after it]",
			),
			output,
		);
		const row = lines.find((line) => line.startsWith("history://sessions/s1:1: needle one y"));
		assert.ok(row !== undefined, output);
		assert.ok(fullRow.startsWith(row) && row.length < fullRow.length, output);
		const next = continuation(output);
		assert.ok(next, output);
		const second = (await router.search!(next, request("needle"))) ?? "";
		assert.ok(Buffer.byteLength(second) <= 500, `${Buffer.byteLength(second)}: ${second}`);
		assert.ok(second.split("\n").includes("history://sessions/s1:2: needle two"), second);
		await store.close();
	});
});
