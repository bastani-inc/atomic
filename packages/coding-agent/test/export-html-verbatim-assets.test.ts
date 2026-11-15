import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { describe, it } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.js";
import { SessionManager } from "../src/core/session-manager.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function readAsset(relativePath: string): string {
	return readFileSync(new URL(`../src/core/export-html/${relativePath}`, import.meta.url), "utf-8");
}

async function exportOneMessageSession(): Promise<string> {
	initTheme("dark");
	const tempDir = mkdtempSync(join(tmpdir(), "atomic-export-verbatim-"));
	try {
		const session = await SessionManager.create(tempDir, join(tempDir, "sessions"));
		await session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		const sessionPath = session.getSessionFile();
		assert.ok(sessionPath);
		return readFileSync(await exportFromFile(sessionPath, join(tempDir, "out.html")), "utf8");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

describe("export HTML asset embedding", () => {
	it("embeds template.js and highlight.min.js byte-identical to their sources (#4887)", async () => {
		const templateJs = readAsset("template.js");
		const highlightJs = readAsset("vendor/highlight.min.js");
		const html = await exportOneMessageSession();
		const scripts = [...parseHTML(html).document.querySelectorAll("script")].map(
			(script) => script.textContent ?? "",
		);

		assert.ok(
			scripts.some((script) => script === highlightJs),
			"highlight.min.js is embedded verbatim",
		);
		assert.ok(
			scripts.some((script) => script === `\n${templateJs}\n  `),
			"template.js is embedded verbatim",
		);
		assert.ok(html.includes('<span class="info-value">$${totalCost.toFixed(3)}</span>'), "cost line keeps its $");
	});
});
