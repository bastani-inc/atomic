import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION, type SessionRecordHeader } from "../src/core/storage/session/types.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import type { InternalSearchRequest } from "../src/core/tools/resource-selectors.js";

const PROJECT = resolve("/projects/regex-anchor");
const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const BODY_LINES = 3000;

function header(id: string): SessionRecordHeader {
	return { id, version: SESSION_FORMAT_VERSION, createdAt: new Date(BASE).toISOString(), cwd: PROJECT };
}

function message(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(BASE).toISOString(),
		message: { role: "user", content: text, timestamp: BASE },
	};
}

const request = (pattern: string): InternalSearchRequest => ({
	pattern,
	ignoreCase: false,
	literal: false,
	contextBefore: 0,
	contextAfter: 0,
});

describe("multi-line history searches of one large entry (#5250)", () => {
	it("anchors ^ at the start of the entry text, not where each search slice of the entry starts (#5250)", async () => {
		const store = new MemorySessionStore();
		try {
			const body = Array.from({ length: BODY_LINES }, (_, index) => `line-${index + 1} ${"x".repeat(90)}`).join(
				"\n",
			);
			await store.create(header("anchor"), [message("e1", body), message("e2", "tail")]);
			const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => undefined });
			const matchRows = async (pattern: string): Promise<string[]> => {
				const out = (await router.search?.("history://sessions/anchor", request(pattern))) ?? "";
				return out.split("\n").filter((line) => /^history:\/\/sessions\/anchor:[\d.]+: line-/.test(line));
			};

			assert.deepEqual(await matchRows("(?s)^line-\\d+ "), []);
			assert.deepEqual(await matchRows("(?s)^(?P<w>line-1) \\w+"), []);
			assert.deepEqual(await matchRows("(?s)(?P<w>line-1) x+$"), []);
			assert.equal((await matchRows("(?sm)^(?P<w>line-1) \\w+")).length, 1);
			assert.equal((await matchRows("(?sm)(?P<w>line-1) x+$")).length, 1);
			assert.match(
				(await router.search?.("history://sessions/anchor", request("(?s)^## [^\\n]+\\n(?P<w>line-1) \\w+"))) ?? "",
				/^history:\/\/sessions\/anchor:1: ## /m,
			);

			const everyLine = await matchRows("(?m)^line-\\d+ x+$");
			assert.ok(everyLine.length > 0);
			for (const line of [657, 1309, BODY_LINES]) assert.equal((await matchRows(`(?m)^line-${line} x+$`)).length, 1);
		} finally {
			await store.close();
		}
	});

	it("does not anchor $ or \\z at a multi-line window cut before the end of the text (#5250)", async () => {
		const store = new MemorySessionStore();
		try {
			const body = Array.from({ length: BODY_LINES }, (_, index) => `line-${index + 1} ${"x".repeat(90)}`).join(
				"\n",
			);
			await store.create(header("anchor"), [message("e1", body), message("e2", "tail")]);
			const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => undefined });
			const matchRows = async (pattern: string): Promise<string[]> => {
				const out = (await router.search?.("history://sessions/anchor", request(pattern))) ?? "";
				return out.split("\n").filter((line) => /^history:\/\/sessions\/anchor:[\d.]+: line-/.test(line));
			};

			assert.deepEqual(await matchRows("(?s)line-5 .*x$"), []);
			assert.deepEqual(await matchRows("(?s)line-5 [^]*x$"), []);
			assert.deepEqual(await matchRows("(?s)line-5 .*x\\z"), []);
			assert.deepEqual(await matchRows("(?s)(?P<w>line-5) .*x$"), []);
			assert.deepEqual(await matchRows("(?s)(?P<w>line-5) .*x\\z"), []);
			assert.deepEqual(await matchRows("(?ms)^line-5 .*x\\z"), []);
			assert.deepEqual(await matchRows("(?ms)^line-5 (?-m:.*x$)"), []);
			assert.deepEqual(await matchRows("(?s)line-5 (?!.*$)x+"), []);
			assert.deepEqual(await matchRows("(?s)line-5 (?!.*\\z)x+"), []);
			assert.deepEqual(await matchRows("(?s)line-5 (?!(?!.*x$))x+"), []);
			assert.deepEqual(await matchRows("(?s)line-5 (?:.*x$|(?!.*$).*x)"), []);
			assert.equal((await matchRows("(?s)line-5 (?:.*x$|(?!.*$).*x|x+)")).length, 1);
			assert.deepEqual(await matchRows("(?s)line-5 (?!.*$)x+\\nline-6 x+|line-5 x+"), [
				`history://sessions/anchor:1: line-5 ${"x".repeat(90)}`,
			]);
			assert.equal((await matchRows("(?s)line-5 (?!foo)x+")).length, 1);
			assert.equal((await matchRows("(?s)line-2995 .*tail$")).length, 1);
			assert.equal((await matchRows("(?s)line-2995 .*tail\\z")).length, 1);
			assert.equal((await matchRows("(?s)(?P<w>line-2995) .*tail$")).length, 1);
			assert.equal((await matchRows("(?s)(?P<w>line-2995) .*tail\\z")).length, 1);
			assert.equal((await matchRows("(?s)line-5 x+|bar$")).length, 1);
			assert.equal((await matchRows("(?s)(?P<w>line-5) x+|bar\\z")).length, 1);
			assert.equal((await matchRows("(?s)(?m:^line-5 .*x$)")).length, 1);
			assert.equal((await matchRows("(?xm:# )\nline-6\\x20x+$)")).length, 1);

			await store.create(header("dollar-literals"), [
				message("d1", `price $100\nline-5 $\n${body}`),
				message("d2", "tail"),
			]);
			const dollarExplicit =
				(await router.search?.("history://sessions/dollar-literals", request("(?s)price \\$100\\nline-5"))) ?? "";
			assert.match(dollarExplicit, /^history:\/\/sessions\/dollar-literals:1: price \$100$/m);
			const dollarClass =
				(await router.search?.("history://sessions/dollar-literals", request("(?s)price [$]100\\nline-5"))) ?? "";
			assert.match(dollarClass, /^history:\/\/sessions\/dollar-literals:1: price \$100$/m);
			const nestedNativeClass =
				(await router.search?.("history://sessions/dollar-literals", request("(?s)(?P<w>line-5) [[a]$]"))) ?? "";
			assert.match(nestedNativeClass, /^history:\/\/sessions\/dollar-literals:1: line-5 \$$/m);
		} finally {
			await store.close();
		}
	});
});
