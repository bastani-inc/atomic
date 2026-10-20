import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { afterAll, beforeAll, describe, it } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.js";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "../src/core/session-manager.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function loadMarkdownParser(html: string): (text: string) => string {
	const sessionData = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
	const scripts = html
		.split("<script>")
		.slice(1)
		.map((chunk) => chunk.slice(0, chunk.indexOf("</script>")));
	const viewer = scripts.pop();
	if (!sessionData || !viewer) throw new Error("Missing exported session data or viewer script");
	const context = createContext({
		atob,
		TextDecoder,
		URLSearchParams,
		document: { getElementById: () => ({ textContent: sessionData }), querySelector: () => null },
		window: { location: { search: "" } },
	});
	for (const script of scripts) {
		runInContext(script, context);
	}
	return runInContext(
		viewer.replace("function safeMarkedParse(", "return safeMarkedParse; function safeMarkedParse("),
		context,
	);
}

describe("HTML export CJK emphasis (#3353, #10154)", () => {
	let tempDir: string;
	let parse: (text: string) => string;

	beforeAll(async () => {
		initTheme("dark");
		tempDir = mkdtempSync(join(tmpdir(), "atomic-export-cjk-"));
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "cjk-test",
			timestamp: new Date(0).toISOString(),
			cwd: tempDir,
		} satisfies SessionHeader;
		const sessionPath = join(tempDir, "session.jsonl");
		writeFileSync(sessionPath, `${JSON.stringify(header)}\n`);
		parse = loadMarkdownParser(readFileSync(await exportFromFile(sessionPath, join(tempDir, "out.html")), "utf8"));
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("renders emphasis delimited next to CJK punctuation", () => {
		assert.equal(parse("**这是测试。**后面"), "<p><strong>这是测试。</strong>后面</p>\n");
		assert.equal(parse("**一句话说清：**一台机器"), "<p><strong>一句话说清：</strong>一台机器</p>\n");
		assert.equal(parse("**要点到此为止。**20 小时"), "<p><strong>要点到此为止。</strong>20 小时</p>\n");
		assert.equal(parse("字**「引用」**字"), "<p>字<strong>「引用」</strong>字</p>\n");
		assert.equal(parse("*斜体。*后面"), "<p><em>斜体。</em>后面</p>\n");
	});

	it("keeps CommonMark flanking rules for non-CJK text", () => {
		assert.equal(parse("**end.**Then next"), "<p>**end.**Then next</p>\n");
	});
});
