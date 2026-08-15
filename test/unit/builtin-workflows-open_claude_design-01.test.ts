// @ts-nocheck

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import {
	assertOutputTypes,
	assertWorkflowDefinition,
	fieldChoices,
	fieldDefault,
	fieldDescription,
	fieldKind,
	fieldRequired,
	makeMockCtx,
	readPathEndsWith,
} from "./builtin-workflows-helpers.js";

describe("open-claude-design", () => {
	test("loads and declares only the remaining workflow contract", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		assertWorkflowDefinition(mod.default);
		assert.equal(mod.default.name, "open-claude-design");
		assert.deepEqual(Object.keys(mod.default.inputs).sort(), ["discover_references", "prompt"]);
		assert.equal(mod.default.inputs.max_refinements, undefined);
		assert.equal(fieldRequired(mod.default.inputs.prompt), true);
		assertOutputTypes(mod.default.outputs, {
			artifact: "text",
			artifact_dir: "text",
			design_system: "text",
			handoff: "text",
			import_context: "text",
			output_type: "text",
			preview_file_url: "text",
			preview_path: "text",
			run_id: "text",
			spec_file_url: "text",
			spec_path: "text",
			playwright_cli_status: "text",
		});
		assert.equal(mod.default.outputs.approved_for_export, undefined);
		assert.equal(mod.default.outputs.refinements_completed, undefined);
	});

	test("declares discover_references boolean input defaulting true", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const schema = mod.default.inputs.discover_references;
		assert.equal(fieldKind(schema), "boolean");
		assert.equal(fieldDefault(schema), true);
		assert.ok(fieldDescription(schema).length > 0);
	});

	test("discovery decision schema retains the canonical output types", async () => {
		const utils = await import("../../packages/workflows/builtin/open-claude-design-utils.js");
		const schema = (utils.discoveryDecisionSchema as { properties: Record<string, unknown> }).properties.output_type;
		assert.equal(fieldKind(schema), "select");
		for (const choice of ["prototype", "wireframe", "page", "component", "theme", "tokens"]) {
			assert.ok(fieldChoices(schema).includes(choice), choice);
		}
	});

	test("runs one generation, one live session, and export after helper exit", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const cwd = mkdtempSync(join(tmpdir(), "ocd-live-one-shot-"));
		try {
			const ctx = makeMockCtx(
				{ prompt: "Design a kanban board" },
				{
					cwd,
					task: (name) => {
						if (name === "discovery") {
							return JSON.stringify({
								brief: "A kanban board component.",
								output_type: "component",
								references: ["https://example.com/reference"],
							});
						}
						return undefined;
					},
					tool: (name) => {
						if (name === "live-poll-1-1")
							return { type: "generate", id: "g1", raw: '{"type":"generate","id":"g1"}' };
						if (name === "live-poll-1-2") return { type: "steer", id: "s1", raw: '{"type":"steer","id":"s1"}' };
						if (name === "live-poll-1-3")
							return { type: "manual_edit_apply", id: "m1", raw: '{"type":"manual_edit_apply","id":"m1"}' };
						if (name === "live-poll-1-4") return { type: "accept", id: "a1", raw: '{"type":"accept","id":"a1"}' };
						if (name === "live-poll-1-5")
							return { type: "discard", id: "d1", raw: '{"type":"discard","id":"d1"}' };
						if (name === "live-poll-1-6")
							return { type: "prefetch", id: "p1", raw: '{"type":"prefetch","id":"p1"}' };
						return { type: "exit", raw: '{"type":"exit"}' };
					},
				},
			);

			const result = await d.run(ctx);

			assert.ok(ctx.calls.task.includes("discovery"));
			assert.ok(ctx.calls.task.includes("reference-discovery"));
			assert.ok(ctx.calls.task.includes("generate-1"));
			assert.ok(ctx.calls.task.includes("user-feedback-1-start"));
			assert.ok(ctx.calls.task.includes("live-generate-1-1"));
			assert.ok(ctx.calls.task.includes("live-steer-1-2"));
			assert.ok(ctx.calls.task.includes("live-manual_edit_apply-1-3"));
			assert.equal(ctx.calls.task.includes("user-feedback-1"), false);
			assert.equal(
				ctx.calls.task.some((name) => name.startsWith("generate-2")),
				false,
			);
			assert.equal(
				ctx.calls.task.some((name) => name.startsWith("user-feedback-2")),
				false,
			);
			assert.equal(ctx.calls.task.includes("exporter"), true);
			assert.equal(ctx.calls.task.includes("final-display"), true);
			assert.deepEqual(
				ctx.calls.tool.filter((name) => name.startsWith("live-poll-")),
				[
					"live-poll-1-1",
					"live-poll-1-2",
					"live-poll-1-3",
					"live-poll-1-4",
					"live-poll-1-5",
					"live-poll-1-6",
					"live-poll-1-7",
				],
			);
			assert.deepEqual(
				ctx.calls.tool.filter((name) => name.startsWith("live-reply-")),
				["live-reply-1-1", "live-reply-1-2", "live-reply-1-3"],
			);
			assert.equal(existsSync(join(result.artifact_dir as string, "feedback")), false);
			assert.equal(typeof result.artifact, "string");
			assert.equal(typeof result.handoff, "string");
			assert.equal(result.output_type, "component");
			assert.ok(readPathEndsWith(ctx.calls.taskOptions["generate-1"]?.[0], "design-context.md"));
			assert.ok(readPathEndsWith(ctx.calls.taskOptions["generate-1"]?.[0], "references.md"));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("keeps the exporter and final-display browser guidance", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx({ prompt: "Design a dashboard" });
		await d.run(ctx);
		for (const name of ["user-feedback-1-start", "final-display"]) {
			const prompt = ctx.calls.prompts[name]?.[0] ?? "";
			assert.match(prompt, /<browser_use_guidelines>/);
			assert.match(prompt, /which playwright-cli/);
			assert.match(prompt, /missing browser executable/);
		}
	});

	test("definition is frozen", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		assert.equal(Object.isFrozen(mod.default), true);
		assert.equal(Object.isFrozen(mod.default.inputs), true);
	});
});
