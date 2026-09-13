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
	assert.ok(installation.specifiers.includes("@sinclair/typebox"));
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
	{ kind: "enhancement", title: "42", change: "Add navigation", why: "Accessibility" },
	{ kind: "bug", title: "42", description: "Editor loses input", repro: "Resize the terminal" },
];
for (const draft of drafts) {
	assert.deepEqual(validate(draft), draft);
	const prepared = await tool.execute("valid", validate(draft));
	assert.equal(prepared.details.title, "42");
	assert.equal(prepared.details.kind, draft.kind);
	assert.ok(prepared.details.body.length > 0);
	assert.deepEqual(prepared.details.privacySummary, []);
	if (bridged) {
		const normalized = validate({ ...draft, title: 42 });
		assert.deepEqual(normalized, draft);
		assert.deepEqual(await tool.execute("normalized", normalized), prepared);
	} else {
		assert.throws(() => validate({ ...draft, title: 42 }), /title: must be string/);
	}
	assert.throws(() => validate({ ...draft, title: { nested: "title" } }), /title: must be string/);
	assert.throws(() => validate({ ...draft, kind: "question" }), /kind:/);
}
console.log(bridged ? "bridged bundle normalizes numeric titles" : "native Node bundle rejects numeric titles");
