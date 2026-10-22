import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { getSystemMessageText, renderSystemMessageUpdate, type SystemMessage } from "@earendil-works/pi-ai";
import { parseHTML } from "linkedom";
import { describe, it } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.js";
import { SessionManager } from "../src/core/session-manager.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type ExportFixtureEntry =
	| {
			type: "message";
			id: string;
			parentId: string | null;
			message: SystemMessage | { role: "user"; content: string };
	  }
	| { type: "compaction"; id: string; parentId: string | null; systemMessage: SystemMessage };

interface SystemHelpers {
	getSystemMessageText(message: SystemMessage): string;
	renderSystemMessageUpdate(message: SystemMessage): string;
	isLeadingSystemEntry(entry: { id: string; parentId: string | null }): boolean;
	describeSystemUpdate(message: SystemMessage): string;
}

const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

function loadSystemHelpers(entries: readonly ExportFixtureEntry[]): SystemHelpers {
	const start = templateJs.indexOf("function systemContentText(content)");
	const end = templateJs.indexOf("const hasSystemEntries");
	assert.ok(start >= 0);
	assert.ok(end > start);
	const context: { entries: readonly ExportFixtureEntry[]; helpers?: SystemHelpers } = { entries };
	runInNewContext(
		`const byId = new Map(entries.map(entry => [entry.id, entry]));
		${templateJs.slice(start, end)}
		helpers = { getSystemMessageText, renderSystemMessageUpdate, isLeadingSystemEntry, describeSystemUpdate };`,
		context,
	);
	assert.ok(context.helpers);
	return context.helpers;
}

const initial: SystemMessage = {
	role: "system",
	content: "You are a helpful assistant.",
	sections: { rules: "<rules>\nbe concise\n</rules>", project_context: "<project_context>\nv1\n</project_context>" },
	toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } as never }],
	timestamp: 1,
};

const update: SystemMessage = {
	role: "system",
	content: [{ type: "text", text: "Extra instructions" }],
	sections: { project_context: "<project_context>\nv2\n</project_context>", rules: null },
	toolsAdded: [
		{ name: "bash", description: "Run a command", parameters: { type: "object", properties: {} } as never },
	],
	toolsRemoved: [{ name: "read" }],
	timestamp: 2,
};

const entries: ExportFixtureEntry[] = [
	{ type: "message", id: "s1", parentId: null, message: initial },
	{ type: "message", id: "u1", parentId: "s1", message: { role: "user", content: "hi" } },
	{ type: "message", id: "s2", parentId: "u1", message: update },
];

async function renderExportedTranscript(): Promise<string> {
	initTheme("dark");
	const tempDir = mkdtempSync(join(tmpdir(), "atomic-export-system-"));
	try {
		const session = await SessionManager.create(tempDir, join(tempDir, "sessions"));
		await session.appendMessage(initial);
		await session.appendMessage({ role: "user", content: "hi", timestamp: 2 });
		await session.appendMessage(update);
		await session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 3,
		});
		const sessionPath = session.getSessionFile();
		assert.ok(sessionPath);
		const html = readFileSync(await exportFromFile(sessionPath, join(tempDir, "out.html")), "utf8");
		const { window, document } = parseHTML(html);
		Object.assign(window.HTMLElement.prototype, { scrollIntoView: () => undefined });
		const location = { search: "", hash: "" };
		Object.defineProperty(window, "location", { configurable: true, value: location });
		const context = {
			window,
			document,
			atob,
			TextDecoder,
			URLSearchParams,
			console,
			navigator: { clipboard: undefined },
			location,
			history: { replaceState: () => undefined },
			localStorage: { getItem: () => null, setItem: () => undefined },
			matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
			requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
			setTimeout,
			clearTimeout,
		};
		for (const script of document.querySelectorAll("script")) {
			if (script.getAttribute("type") === "application/json") continue;
			runInNewContext(script.textContent ?? "", context);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
		return document.getElementById("messages")?.textContent ?? document.body.textContent ?? "";
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

describe("export HTML system messages (pi #11261)", () => {
	it("renders system message text the same way the model receives it", () => {
		const helpers = loadSystemHelpers(entries);
		assert.equal(helpers.getSystemMessageText(initial), getSystemMessageText(initial));
		assert.equal(helpers.renderSystemMessageUpdate(update), renderSystemMessageUpdate(update));
	});

	it("renders the first system entry on a branch as the prompt and later ones as updates", () => {
		const helpers = loadSystemHelpers(entries);
		assert.equal(helpers.isLeadingSystemEntry(entries[0]), true);
		assert.equal(helpers.isLeadingSystemEntry(entries[2]), false);
		assert.equal(helpers.describeSystemUpdate(update), "instructions, project_context, -rules, tools +bash -read");
	});

	it("treats a compaction snapshot as earlier system state", () => {
		const helpers = loadSystemHelpers([
			{ type: "compaction", id: "c1", parentId: null, systemMessage: initial },
			{ type: "message", id: "s2", parentId: "c1", message: update },
		]);
		assert.equal(helpers.isLeadingSystemEntry({ id: "s2", parentId: "c1" }), false);
	});

	it("renders system entries in the transcript", () => {
		assert.match(templateJs, /if \(msg\.role === 'system'\) \{\s*let html = '';/);
		assert.ok(templateJs.includes("renderSystemPromptBlock('System Prompt', text)"));
		assert.ok(templateJs.includes("renderToolsList('Available Tools', msg.toolsAdded)"));
	});

	it("shows the system prompt, tools and later updates in the rendered transcript", async () => {
		const transcript = await renderExportedTranscript();
		for (const expected of [
			"System Prompt",
			"You are a helpful assistant.",
			"Available Tools",
			"System Prompt Update: instructions, project_context, -rules, tools +bash -read",
			"Extra instructions",
			"Tools Added",
			"Tools Removed",
		]) {
			assert.ok(transcript.includes(expected), `rendered transcript is missing ${JSON.stringify(expected)}`);
		}
	});
});
