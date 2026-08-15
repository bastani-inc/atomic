// @ts-nocheck

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

describe("open-claude-design — deterministic live-review gate", () => {
	test("skip exports as-is without opening a live session", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const cwd = mkdtempSync(join(tmpdir(), "ocd-skip-review-"));
		try {
			const ctx = makeMockCtx(
				{ prompt: "Design a dashboard" },
				{
					cwd,
					uiSelect: (_message, options) => options[1],
				},
			);

			const result = await d.run(ctx);

			assert.ok(ctx.calls.task.includes("generate-1"));
			assert.equal(
				ctx.calls.task.some((name) => name.startsWith("user-feedback-")),
				false,
			);
			assert.equal(
				ctx.calls.tool.some((name) => name.startsWith("live-")),
				false,
			);
			assert.deepEqual(
				ctx.calls.task.filter((name) => name === "exporter" || name === "final-display"),
				["exporter", "final-display"],
			);
			assert.equal(existsSync(join(result.artifact_dir as string, "feedback")), false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("an unavailable UI adapter still runs the live session", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ prompt: "Design a dashboard" },
			{
				uiSelect: () => {
					throw new Error(
						"atomic-workflows: interactive ctx.ui.select is unavailable in headless (non-interactive) mode; run the workflow in interactive mode",
					);
				},
			},
		);

		await d.run(ctx);
		assert.ok(ctx.calls.task.includes("user-feedback-1-start"));
		assert.ok(ctx.calls.task.includes("exporter"));
	});

	test("a gate lifecycle failure prevents the live session and export", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ prompt: "Design a dashboard" },
			{
				uiSelect: () => {
					throw new Error("durable checkpoint persistence failed");
				},
			},
		);

		await assert.rejects(() => d.run(ctx), /durable checkpoint persistence failed/);
		assert.ok(ctx.calls.task.includes("generate-1"));
		assert.equal(
			ctx.calls.task.some((name) => name.startsWith("user-feedback-")),
			false,
		);
		assert.equal(ctx.calls.task.includes("exporter"), false);
	});
});

describe("open-claude-design — live session termination", () => {
	test("a start-stage failure propagates without exporting", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ prompt: "Design a dashboard" },
			{
				task: (name) => {
					if (name === "user-feedback-1-start") throw new Error("live session failed");
					return undefined;
				},
			},
		);

		await assert.rejects(() => d.run(ctx), /live session failed/);
		assert.equal(ctx.calls.task.includes("exporter"), false);
	});
});
