// @ts-nocheck

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { buildBoundaryText } from "../../packages/coding-agent/src/core/compaction/context-clear.js";
import { keepContext } from "../../packages/workflows/src/authoring/keep-context.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

/**
 * The helper is only worth anything if what it emits is what the recovery instructions tell an agent to search for
 * after a clear. These assert the round trip rather than the string shape, so a change to either side fails here.
 */
describe("keepContext authoring primitive", () => {
	test("wraps text in the tags the recovery instructions name", () => {
		assert.equal(keepContext("Research only."), "<keepContext>\nResearch only.\n</keepContext>");
	});

	test("trims surrounding whitespace so the tags own their own lines", () => {
		assert.equal(keepContext("\n  Research only.  \n"), "<keepContext>\nResearch only.\n</keepContext>");
	});

	test("is idempotent so composing already-wrapped text does not nest", () => {
		const once = keepContext("Do not implement.");
		assert.equal(keepContext(once), once);
	});

	test("preserves internal line structure", () => {
		assert.equal(keepContext("first\nsecond"), "<keepContext>\nfirst\nsecond\n</keepContext>");
	});

	test("the recovery instructions search for the tag the helper emits, first and verbatim", () => {
		const recovery = buildBoundaryText(
			{ sessionId: "session-1", tokensBefore: 100, entriesBefore: 10, access: "read-search" },
			20,
		);
		const tag = keepContext("Research only.").split("\n")[0];
		assert.equal(tag, "<keepContext>");
		assert.ok(
			recovery.includes(
				`1. Every ${tag} span, verbatim and whole: search history://sessions/session-1 for "keepContext".`,
			),
		);
	});
});

/**
 * The docs tell agents to tag critical parts of the `inputs` they pass to the workflow tool.
 * That only works if tags written into an input reach the stage prompts that inherit it, and if
 * a workflow that also tags the same field does not double-wrap it.
 */
describe("keepContext in caller-supplied workflow inputs", () => {
	let tempCwd: string | undefined;

	beforeEach(() => {
		tempCwd = mkdtempSync(join(tmpdir(), "atomic-keepcontext-"));
	});

	afterEach(() => {
		if (tempCwd !== undefined) {
			rmSync(tempCwd, { recursive: true, force: true });
			tempCwd = undefined;
		}
	});

	test("tags written into run inputs reach the stage prompts that inherit them", async () => {
		const mod = await import("../../packages/workflows/builtin/ralph.js");
		const ctx = makeMockCtx({
			prompt: `${keepContext("Do not touch the release pipeline.")}\n\nBackground reference material.`,
			max_loops: 1,
			base_branch: "main",
			git_worktree_dir: "",
			create_pr: false,
		});

		await mod.default.run({ ...ctx, cwd: tempCwd });

		const prompts = Object.values(ctx.calls.prompts).flat();
		assert.ok(prompts.length > 0, "expected ralph to produce stage prompts");
		const carrying = prompts.filter((text) =>
			text.includes("<keepContext>\nDo not touch the release pipeline.\n</keepContext>"),
		);
		assert.ok(carrying.length > 0, "expected caller tags to survive into stage prompts verbatim");
	});

	test("an already-tagged acceptance_criteria input is not double-wrapped", async () => {
		const mod = await import("../../packages/workflows/builtin/ralph.js");
		const ctx = makeMockCtx({
			prompt: "Add a small feature",
			acceptance_criteria: keepContext("The public API must not change."),
			max_loops: 1,
			base_branch: "main",
			git_worktree_dir: "",
			create_pr: false,
		});

		await mod.default.run({ ...ctx, cwd: tempCwd });

		for (const text of Object.values(ctx.calls.prompts).flat()) {
			assert.ok(
				!text.includes("<keepContext>\n<keepContext>"),
				"caller-supplied tags must not nest with the workflow's own protection",
			);
		}
	});
});
