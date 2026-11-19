import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it, vi } from "vitest";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION } from "../src/core/storage/session/types.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import type { InternalSearchRequest } from "../src/core/tools/resource-selectors.js";

const cwd = resolve("/project");
const createdAt = "2026-10-01T00:00:00.000Z";
const request: InternalSearchRequest = {
	pattern: "needle",
	ignoreCase: false,
	literal: false,
	contextBefore: 0,
	contextAfter: 0,
};

it("a root history search returns the complete session row within its budget", async () => {
	const store = new MemorySessionStore();
	const text = `needle ${"s".repeat(400)} session end`;
	await store.create({ id: "session", version: SESSION_FORMAT_VERSION, createdAt, cwd }, [
		{
			type: "message",
			id: "message",
			parentId: null,
			timestamp: createdAt,
			message: { role: "user", content: text, timestamp: Date.parse(createdAt) },
		},
	]);
	for (const bytes of [1_400, 1_600, 1_800, 2_000]) {
		const router = createHistoryRouter({
			cwd,
			sessionStore: () => store,
			budget: { bytes },
		});
		const output = (await router.search!("history://", request)) ?? "";
		assert.ok(Buffer.byteLength(output) <= bytes, output);
		assert.ok(output.split("\n").includes(`history://sessions/session:1: ${text}`), `${bytes}: ${output}`);
	}
	await store.close();
});

it("a root history search preserves limit and offset when a domain cannot be searched (#5250)", async () => {
	const router = createHistoryRouter({
		cwd,
		sessionStore: () => {
			throw new Error("zero rows must not read the store");
		},
		budget: { rows: 0 },
	});
	const output = (await router.search!("history://?limit=3&offset=7", request)) ?? "";
	const continuation = /^history:\/\/sessions:0: \[.*continue with (history:\/\/sessions[^\s]+)\]$/m.exec(output)?.[1];
	assert.ok(continuation, output);
	const next = new URL(continuation);
	assert.equal(next.searchParams.get("limit"), "3", output);
	assert.equal(next.searchParams.get("offset"), "7", output);
});
