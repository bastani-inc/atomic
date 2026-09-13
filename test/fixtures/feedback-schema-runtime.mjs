import assert from "node:assert/strict";

// Regression for #2799, review 3998253205: exercise the built feedback bundle,
// not a copied schema. Each runtime gets a fresh process so the bridge cannot
// affect the native Node dependency resolution control.
const bridged = process.argv[2] === "bridged";
assert.equal(Boolean(process.versions.bun), bridged);
if (bridged) {
	const { installHostModuleBridge } = await import(
		"../../packages/coding-agent/src/core/extensions/host-module-bridge.js"
	);
	const installation = await installHostModuleBridge();
	assert.equal(installation.installed, true);
	assert.ok(installation.specifiers.includes("typebox"));
}

const { validateToolArguments } = await import("../../packages/ai/dist/index.js");
const { default: feedback } = await import("../../packages/coding-agent/dist/builtin/feedback/index.bundle.mjs");
let tool;
feedback({
	registerCommand() {},
	registerTool(candidate) {
		if (candidate.name === "feedback_prepare_issue") tool = candidate;
	},
});
assert.ok(tool, "built feedback bundle must register preparation");

function validate(fields) {
	return validateToolArguments(tool, {
		type: "toolCall",
		id: "runtime-schema",
		name: tool.name,
		arguments: fields,
	});
}

const drafts = [
	{
		kind: "enhancement",
		title: "Navigation",
		change: "Add navigation",
		why: "Accessibility",
		how: "Use arrow keys",
	},
	{
		kind: "bug",
		title: "Editor input",
		description: "Editor loses input",
		repro: "Resize the terminal",
		expected: "Retain input",
		version: "0.0.0",
	},
];
for (const draft of drafts) {
	assert.deepEqual(validate(draft), draft);
	const prepared = await tool.execute("valid", validate(draft));
	assert.equal(prepared.details.title, draft.title);
	assert.equal(prepared.details.kind, draft.kind);
	assert.ok(prepared.details.body.length > 0);
	assert.deepEqual(prepared.details.privacySummary, []);
	for (const field of Object.keys(draft).filter((key) => key !== "kind")) {
		for (const value of [42, true]) {
			const expected = { ...draft, [field]: String(value) };
			const normalized = validate({ ...draft, [field]: value });
			assert.deepEqual(normalized, expected);
			assert.deepEqual(await tool.execute("normalized", normalized), await tool.execute("text", expected));
		}
		for (const value of [{ nested: "text" }, ["text"]]) {
			assert.throws(() => validate({ ...draft, [field]: value }), new RegExp(`${field}: must be string`));
		}
		if (field === "title") {
			const normalized = validate({ ...draft, title: null });
			assert.deepEqual(normalized, { ...draft, title: "null" });
			assert.deepEqual(
				await tool.execute("null-title", normalized),
				await tool.execute("text-title", { ...draft, title: "null" }),
			);
		} else {
			assert.deepEqual(
				validate({ ...draft, [field]: null }),
				Object.fromEntries(Object.entries(draft).filter(([key]) => key !== field)),
			);
		}
	}
	await assert.rejects(() => tool.execute("empty-title", { ...draft, title: "" }), /Title is required/);
	assert.throws(() => validate({ ...draft, kind: "question" }), /kind:/);
}
console.log(`${bridged ? "bridged" : "native Node"} bundle preserves the shared string-field validation contract`);
