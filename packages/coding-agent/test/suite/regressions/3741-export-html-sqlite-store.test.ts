import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../../../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../../src/core/storage/session/sql-session-store.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness } from "../harness.js";

function exportedMessageTexts(html: string): string[] {
	const data = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(html)?.[1] ?? "";
	const session: { entries: Array<{ message?: { content: string | readonly object[] } }> } = JSON.parse(
		Buffer.from(data, "base64").toString("utf8"),
	);
	return session.entries.flatMap((entry) =>
		typeof entry.message?.content === "string" ? [entry.message.content] : [],
	);
}

describe("HTML export from any session store", () => {
	it("exports a session stored in the SQLite session store to HTML (#3741)", async () => {
		initTheme("dark");
		const dir = mkdtempSync(join(tmpdir(), "atomic-3741-sqlite-"));
		const store = await SqlSessionStore.open(await openNodeSqliteDatabase(join(dir, "sessions.sqlite")));
		const sessionManager = await SessionManager.create(store, dir);
		const harness = await createHarness({ sessionManager });
		try {
			assert.equal(sessionManager.getSessionFile(), undefined);
			await sessionManager.appendMessage({ role: "user", content: "sqlite export question", timestamp: 1 });
			const outputPath = join(dir, "export.html");
			assert.equal(await harness.session.exportToHtml(outputPath), outputPath);
			assert.ok(existsSync(outputPath));
			assert.deepEqual(exportedMessageTexts(readFileSync(outputPath, "utf8")), ["sqlite export question"]);
		} finally {
			await harness.cleanup();
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exports a JSONL-backed session to HTML (#3741)", async () => {
		initTheme("dark");
		const dir = mkdtempSync(join(tmpdir(), "atomic-3741-jsonl-"));
		const sessionManager = await SessionManager.create(dir, join(dir, "sessions"));
		const harness = await createHarness({ sessionManager });
		try {
			assert.ok(sessionManager.getSessionFile());
			await sessionManager.appendMessage({ role: "user", content: "jsonl export question", timestamp: 1 });
			const outputPath = join(dir, "export.html");
			await harness.session.exportToHtml(outputPath);
			assert.deepEqual(exportedMessageTexts(readFileSync(outputPath, "utf8")), ["jsonl export question"]);
		} finally {
			await harness.cleanup();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
