import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { getSystemMessageText, renderSystemMessageUpdate, type SystemMessage } from "@earendil-works/pi-ai";
import { describe, it } from "vitest";

interface SystemHelpers {
	getSystemMessageText(message: SystemMessage): string;
	renderSystemMessageUpdate(message: SystemMessage): string;
	isLeadingSystemEntry(entry: { id: string; parentId: string | null }): boolean;
	describeSystemUpdate(message: SystemMessage): string;
}

const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

function loadSystemHelpers(entries: unknown[]): SystemHelpers {
	const start = templateJs.indexOf("function systemContentText(content)");
	const end = templateJs.indexOf("const hasSystemEntries");
	assert.ok(start >= 0);
	assert.ok(end > start);
	const context: { entries: unknown[]; helpers?: SystemHelpers } = { entries };
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

const entries = [
	{ type: "message", id: "s1", parentId: null, message: initial },
	{ type: "message", id: "u1", parentId: "s1", message: { role: "user", content: "hi" } },
	{ type: "message", id: "s2", parentId: "u1", message: update },
];

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
});
