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
			const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
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

	it("finishes anchored lookbehind searches across entries within one call (#5250)", async () => {
		const store = new MemorySessionStore();
		try {
			await store.create(
				header("anchored-lookbehind"),
				Array.from({ length: 60 }, (_, index) => message(`e${index}`, "x".repeat(1_600))),
			);
			await store.create(
				header("anchored-lookbehind-lines"),
				Array.from({ length: 60 }, (_, index) => message(`e${index}`, "x\n".repeat(800))),
			);
			const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
			for (const id of ["anchored-lookbehind", "anchored-lookbehind-lines"]) {
				const out = await router.search?.(`history://sessions/${id}`, request("(?s)^(?=.*(?<!not )approvedXYZ)"));
				assert.ok(out);
				assert.doesNotMatch(out, /continue with|budget ran out/, id);
				assert.doesNotMatch(out, new RegExp(`^history://sessions/${id}:[1-9]\\d*:`, "m"), id);
			}
		} finally {
			await store.close();
		}
	});

	it("anchors ^ and \\A at the start of the entry when a multi-line pattern has a lookbehind (#5250)", async () => {
		const store = new MemorySessionStore();
		try {
			const body = Array.from({ length: BODY_LINES }, (_, index) => `line-${index + 1} ${"x".repeat(90)}`).join(
				"\n",
			);
			await store.create(header("lookbehind"), [
				message("e1", "first entry"),
				message("e2", "needle here"),
				message("e3", body),
			]);
			const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
			const matchRows = async (pattern: string): Promise<string[]> => {
				const out = (await router.search?.("history://sessions/lookbehind", request(pattern))) ?? "";
				return out.split("\n").filter((line) => /^history:\/\/sessions\/lookbehind:[1-9][\d.]*: /.test(line));
			};
			const secondEntry = ["history://sessions/lookbehind:2: ## 2026-11-01T00:00:00.000Z user"];

			assert.deepEqual(await matchRows("(?s)^## [^\\n]+\\nneedle(?<=needle)"), secondEntry);
			assert.deepEqual(await matchRows("(?s)\\A## [^\\n]+\\nneedle(?<=needle)"), secondEntry);
			assert.deepEqual(await matchRows("(?s)(?<=^## [^\\n]+\\n)needle"), [
				"history://sessions/lookbehind:2: needle here",
			]);
			assert.deepEqual(await matchRows("(?s)(?<=\\A## [^\\n]+\\n)needle"), [
				"history://sessions/lookbehind:2: needle here",
			]);
			assert.deepEqual(await matchRows("(?s)(?<=\\A?## [^\\n]+\\n)needle"), [
				"history://sessions/lookbehind:2: needle here",
			]);
			assert.deepEqual(await matchRows("(?s)^line-\\d+(?<=\\d) "), []);
			assert.deepEqual(await matchRows("(?s)(?<=^line-\\d+ )x"), []);
			assert.deepEqual(await matchRows("(?s)\\Aline-\\d+(?<=\\d) "), []);
			assert.equal((await matchRows("(?sm)^line-657 x+$(?<=x)")).length, 1);
		} finally {
			await store.close();
		}
	});

	it("accepts quantified \\A and \\z anchors in multi-line session and run searches (#5250)", async () => {
		const store = new MemorySessionStore();
		try {
			await store.create(header("quantified"), [message("e1", "needle\nB")]);
			const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
			const url = "history://sessions/quantified";
			const label = `${url}:1`;
			for (const pattern of ["\\A?needle\\n", "(?s)\\A*needle", "(?s)needle\\nB\\z?", "(?s)needle\\nB\\z*"]) {
				const out = (await router.search?.(url, request(pattern))) ?? "";
				assert.ok(
					out.split("\n").some((line) => line.startsWith(label) && line.endsWith(": needle")),
					`${url} ${pattern}: ${out}`,
				);
			}
		} finally {
			await store.close();
		}
	});

	it("does not let a lookahead see past a multi-line window cut before the end of the text (#5250)", async () => {
		const store = new MemorySessionStore();
		try {
			const block = (first: string, count: number) =>
				Array.from({ length: count }, (_, index) => `${first}${"x".repeat(97)}${index}`).join("\n");
			await store.create(header("indented"), [message("e1", `needle\n${block(" ", BODY_LINES)}`)]);
			await store.create(header("lettered"), [message("e1", `needle\n${block("a", BODY_LINES)}`)]);
			await store.create(header("short"), [message("e1", `needle\n${block(" ", 20)}\nend`)]);
			const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
			const matchRows = async (id: string, pattern: string): Promise<string[]> => {
				const out = (await router.search?.(`history://sessions/${id}`, request(pattern))) ?? "";
				return out.split("\n").filter((line) => line.startsWith(`history://sessions/${id}:1: needle`));
			};

			assert.deepEqual(await matchRows("indented", "needle[\\s\\S]*?(?=\\n\\S)"), []);
			assert.deepEqual(await matchRows("lettered", "needle[\\s\\S]*?(?=\\n\\W)"), []);
			assert.deepEqual(await matchRows("lettered", "needle[\\s\\S]*?(?=\\n[^a-z])"), []);
			assert.equal((await matchRows("short", "needle[\\s\\S]*?(?=\\n\\S)")).length, 1);
			assert.equal((await matchRows("lettered", "needle[\\s\\S]*?(?=\\na)")).length, 1);
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
			const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
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

	it("keeps end-of-text assertions false at a multi-line window cut without dropping matches that do not need the end (#5250)", async () => {
		const store = new MemorySessionStore();
		try {
			const body = Array.from({ length: BODY_LINES }, (_, index) => `line-${index + 1} ${"x".repeat(90)}`).join(
				"\n",
			);
			await store.create(header("cut"), [message("e1", `size y\n${body}`), message("e2", "tail")]);
			const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
			const matchRows = async (pattern: string): Promise<string[]> => {
				const out = (await router.search?.("history://sessions/cut", request(pattern))) ?? "";
				return out.split("\n").filter((line) => /^history:\/\/sessions\/cut:[1-9][\d.]*: /.test(line));
			};

			assert.deepEqual(await matchRows("(?s)line-5 .*x(?![\\s\\S])"), []);
			assert.deepEqual(await matchRows("(?s)line-5 [^]*x(?![^])"), []);
			assert.deepEqual(await matchRows("(?s)line-5 x+(?=[\\s\\S]*x$)"), []);
			assert.equal((await matchRows("(?s)line-5 x+(?!.*foo$)")).length, 1);
			assert.equal((await matchRows("(?s)line-5 x+(?![\\s\\S]*foo\\z)")).length, 1);
			assert.equal((await matchRows("(?s)line-5 x+(?<!foo$)")).length, 1);
			assert.deepEqual(await matchRows("(?s)line-5 .*$"), []);
			assert.deepEqual(await matchRows("line-5 x+\\n(?:line-\\d+ x+\\n)*.*$"), []);
			assert.deepEqual(await matchRows("(?s)(?P<w>line-5) .*$"), []);
			assert.deepEqual(await matchRows("(?P<w>line-5) x+\\n(?:line-\\d+ x+\\n)*.*$"), []);
			assert.equal((await matchRows("(?s)line-2995 .*tail(?![\\s\\S])")).length, 1);
			assert.deepEqual(await matchRows("(?s)\\A## [^\\n]+\\nsize y"), [
				"history://sessions/cut:1: ## 2026-11-01T00:00:00.000Z user",
			]);
			assert.deepEqual(await matchRows("(?s)\\A## [^\\n]+\\n(?P<w>size) y"), [
				"history://sessions/cut:1: ## 2026-11-01T00:00:00.000Z user",
			]);
			assert.deepEqual(await matchRows("(?s)\\Aline-\\d+ "), []);
			assert.deepEqual(await matchRows("(?s)\\A(?P<w>line-\\d+) "), []);
			assert.equal((await matchRows("(?s)size [^\\z]\\nline-1 ")).length, 1);
			assert.deepEqual(await matchRows("(?s)size [\\z]\\nline-1 "), []);
			assert.equal((await matchRows("(?s)(?P<w>size) [[:alpha:]]\\nline-1 ")).length, 1);
			assert.equal((await matchRows("(?s)line-5 (?<w>x)\\k<w>+\\nline-6 ")).length, 1);
			assert.deepEqual(await matchRows("(?s)line-5 \\Qx\\E"), []);
			assert.equal((await matchRows("(?s)line-5 \\Qx\\E|line-5 x")).length, 1);

			await store.create(header("quoted"), [message("q1", "QzE QAE")]);
			const quotedRows = async (pattern: string): Promise<string[]> => {
				const out = (await router.search?.("history://sessions/quoted", request(pattern))) ?? "";
				return out.split("\n").filter((line) => /^history:\/\/sessions\/quoted:[1-9]\d*: /.test(line));
			};
			assert.deepEqual(await quotedRows("(?s)\\Q\\z\\E \\Q\\A\\E"), ["history://sessions/quoted:1: QzE QAE"]);
			await store.create(header("open-quoted"), [message("q2", "Qz A")]);
			const openQuoted = (await router.search?.("history://sessions/open-quoted", request("(?s)\\Q\\z \\A"))) ?? "";
			assert.match(openQuoted, /^history:\/\/sessions\/open-quoted:1: Qz A$/m);

			const skipped = Array.from(
				{ length: 300 },
				(_, index): SessionEntry => ({
					type: "custom",
					id: `c${index}`,
					parentId: null,
					timestamp: new Date(BASE).toISOString(),
					customType: "note",
					data: {},
				}),
			);
			await store.create(header("gap"), [message("g1", "foo"), ...skipped, message("g2", "tail")]);
			const gapRows = async (pattern: string): Promise<string[]> => {
				const out = (await router.search?.("history://sessions/gap", request(pattern))) ?? "";
				return out.split("\n").filter((line) => /^history:\/\/sessions\/gap:[1-9]\d*: /.test(line));
			};
			assert.deepEqual(await gapRows("foo\\n[^#]"), []);
			assert.deepEqual(await gapRows("foo(?=\\n)(?![\\s\\S]*bar$)"), ["history://sessions/gap:1: foo"]);
		} finally {
			await store.close();
		}
	});
});
