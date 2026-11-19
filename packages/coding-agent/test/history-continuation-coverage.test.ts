import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION } from "../src/core/storage/session/types.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import type { InternalSearchRequest } from "../src/core/tools/resource-selectors.js";

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
