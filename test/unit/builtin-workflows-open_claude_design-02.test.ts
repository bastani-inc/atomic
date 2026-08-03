// @ts-nocheck

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { describe, test } from "vitest";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

describe("open-claude-design — generate/user-feedback refinement loop (#1464)", () => {
	const previewWithAnnotations = [
		"display_method: playwright-cli interactive annotation",
		"preview_path: /tmp/preview.html",
		"annotated_snapshot: .playwright-cli/annotations-test.png",
		"user_notes:",
		"- I don't like this background; simplify it to a black to grey gradient.",
		"- Make the overall vibe more polished, closer to the Apple website.",
		"next_action_hint: proceed to refinement",
	].join("\n");

	test("threads user feedback directly into the next generate stage", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ prompt: "Redesign the Atomic website", max_refinements: 2 },
			{
				task: (name) => {
					if (name === "user-feedback-1") return previewWithAnnotations;
					if (name === "user-feedback-2") return "user_notes: none";
					return undefined;
				},
			},
		);

		const result = await d.run(ctx);

		assert.ok(ctx.calls.task.includes("generate-1"));
		assert.ok(ctx.calls.task.includes("user-feedback-1"));
		assert.ok(ctx.calls.task.includes("generate-2"));
		assert.ok(ctx.calls.task.includes("user-feedback-2"));
		assert.equal(ctx.calls.task.includes("critique-1"), false);
		assert.equal(ctx.calls.task.includes("screenshot-1"), false);
		assert.equal(ctx.calls.task.includes("apply-changes-1"), false);
		assert.equal(ctx.calls.task.includes("pre-export-scan"), false);
		assert.equal(ctx.calls.task.includes("forced-fix"), false);
		assert.ok(ctx.calls.task.includes("exporter"));
		assert.ok(ctx.calls.task.includes("final-display"));

		const generatePrompt = ctx.calls.prompts["generate-2"]?.[0] ?? "";
		assert.ok(generatePrompt.includes("I don't like this background"));
		assert.ok(generatePrompt.includes("Apple website"));
		assert.doesNotMatch(generatePrompt, /screenshot-validated/i);
		assert.doesNotMatch(generatePrompt, /critique finding/i);
		assert.equal(typeof result.handoff, "string");
		const artifactDir = result.artifact_dir as string;
		rmSync(artifactDir, { recursive: true, force: true });
	});

	test("forks generate and user-feedback loops from their prior sessions", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ prompt: "Redesign the Atomic website", max_refinements: 2 },
			{
				task: (name) => {
					if (name === "user-feedback-1") return previewWithAnnotations;
					if (name === "user-feedback-2") return "user_notes: none";
					return undefined;
				},
				sessionFile: (name) => `/tmp/${name}.jsonl`,
			},
		);

		const result = await d.run(ctx);

		const feedbackOneOptions = ctx.calls.taskOptions["user-feedback-1"]?.[0];
		assert.equal(feedbackOneOptions?.context, undefined);
		assert.equal(feedbackOneOptions?.forkFromSessionFile, undefined);
		const generateTwoOptions = ctx.calls.taskOptions["generate-2"]?.[0];
		assert.equal(generateTwoOptions?.context, "fork");
		assert.equal(generateTwoOptions?.forkFromSessionFile, "/tmp/generate-1.jsonl");
		const feedbackTwoOptions = ctx.calls.taskOptions["user-feedback-2"]?.[0];
		assert.equal(feedbackTwoOptions?.context, "fork");
		assert.equal(feedbackTwoOptions?.forkFromSessionFile, "/tmp/user-feedback-1.jsonl");
		const artifactDir = result.artifact_dir as string;
		rmSync(artifactDir, { recursive: true, force: true });
	});

	test("does not fall back feedback stages to generate sessions", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ prompt: "Redesign the Atomic website", max_refinements: 3 },
			{
				task: (name) => {
					if (name === "user-feedback-1") return previewWithAnnotations;
					if (name === "user-feedback-2") return previewWithAnnotations;
					if (name === "user-feedback-3") return "user_notes: none";
					return undefined;
				},
				sessionFile: (name) => (name.startsWith("generate-") ? `/tmp/${name}.jsonl` : undefined),
			},
		);

		const result = await d.run(ctx);

		for (const name of ["user-feedback-1", "user-feedback-2", "user-feedback-3"]) {
			const options = ctx.calls.taskOptions[name]?.[0];
			assert.equal(options?.context, undefined);
			assert.equal(options?.forkFromSessionFile, undefined);
		}
		const generateTwoOptions = ctx.calls.taskOptions["generate-2"]?.[0];
		assert.equal(generateTwoOptions?.context, "fork");
		assert.equal(generateTwoOptions?.forkFromSessionFile, "/tmp/generate-1.jsonl");
		const generateThreeOptions = ctx.calls.taskOptions["generate-3"]?.[0];
		assert.equal(generateThreeOptions?.context, "fork");
		assert.equal(generateThreeOptions?.forkFromSessionFile, "/tmp/generate-2.jsonl");
		const artifactDir = result.artifact_dir as string;
		rmSync(artifactDir, { recursive: true, force: true });
	});

	test("exports after user feedback reports no changes", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ prompt: "Design a dashboard", max_refinements: 2 },
			{
				task: (name) => {
					if (name === "user-feedback-1") return "user_notes: none";
					return undefined;
				},
			},
		);

		const result = await d.run(ctx);

		assert.ok(ctx.calls.task.includes("generate-1"));
		assert.ok(ctx.calls.task.includes("user-feedback-1"));
		assert.equal(ctx.calls.task.includes("generate-2"), false);
		assert.deepEqual(
			ctx.calls.task.filter((name) => name === "exporter" || name === "final-display"),
			["exporter", "final-display"],
		);
		assert.equal(result.approved_for_export, true);
		const artifactDir = result.artifact_dir as string;
		rmSync(artifactDir, { recursive: true, force: true });
	});
});

describe("open-claude-design — deterministic live-review gate (#2060)", () => {
	const previewWithAnnotations = [
		"display_method: live",
		"preview_path: /tmp/preview.html",
		"user_notes:",
		"- Tighten the hero spacing.",
		"next_action_hint: proceed to refinement",
	].join("\n");

	test("raises a run-level ui.select naming the preview before each user-feedback stage", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ prompt: "Design a dashboard", max_refinements: 2 },
			{
				task: (name) => {
					if (name === "user-feedback-1") return previewWithAnnotations;
					if (name === "user-feedback-2") return "user_notes: none";
					return undefined;
				},
			},
		);

		const result = await d.run(ctx);

		assert.equal(ctx.calls.uiSelects.length, 2);
		const gate = ctx.calls.uiSelects[0];
		assert.match(gate.message, /review round 1 of 2/i);
		assert.ok(gate.message.includes(result.preview_path as string));
		assert.ok(gate.message.includes(result.preview_file_url as string));
		assert.ok(gate.message.includes("/workflow connect"));
		assert.deepEqual([...gate.options], ["Start live review", "Skip remaining review rounds and export as-is"]);
		assert.match(ctx.calls.uiSelects[1].message, /review round 2 of 2/i);
		assert.ok(ctx.calls.task.includes("user-feedback-1"));
		assert.ok(ctx.calls.task.includes("user-feedback-2"));
		const artifactDir = result.artifact_dir as string;
		rmSync(artifactDir, { recursive: true, force: true });
	});

	test("choosing skip accepts the current design without running the feedback stage", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ prompt: "Design a dashboard", max_refinements: 3 },
			{
				uiSelect: (_message, options) => options[1],
			},
		);

		const result = await d.run(ctx);

		assert.ok(ctx.calls.task.includes("generate-1"));
		assert.equal(ctx.calls.task.includes("user-feedback-1"), false);
		assert.equal(ctx.calls.task.includes("generate-2"), false);
		assert.deepEqual(
			ctx.calls.task.filter((name) => name === "exporter" || name === "final-display"),
			["exporter", "final-display"],
		);
		assert.equal(result.approved_for_export, true);
		assert.equal(result.refinements_completed, 1);
		const artifactDir = result.artifact_dir as string;
		rmSync(artifactDir, { recursive: true, force: true });
	});

	test("the executor's unavailable-UI rejection proceeds with the review round instead of blocking", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ prompt: "Design a dashboard", max_refinements: 2 },
			{
				task: (name) => {
					if (name.startsWith("user-feedback-")) return "user_notes: none";
					return undefined;
				},
				uiSelect: () => {
					// Verbatim executor rejection from makeHeadlessUnavailableUIContext.
					throw new Error(
						"atomic-workflows: interactive ctx.ui.select is unavailable in headless (non-interactive) mode; run the workflow in interactive mode or remove the interactive prompt from this stage",
					);
				},
			},
		);

		const result = await d.run(ctx);

		assert.ok(ctx.calls.task.includes("user-feedback-1"));
		assert.equal(result.approved_for_export, true);
		const artifactDir = result.artifact_dir as string;
		rmSync(artifactDir, { recursive: true, force: true });
	});

	test("a gate lifecycle failure propagates instead of opening the review round", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ prompt: "Design a dashboard", max_refinements: 2 },
			{
				uiSelect: () => {
					throw new Error("durable checkpoint persistence failed");
				},
			},
		);

		await assert.rejects(() => d.run(ctx), /durable checkpoint persistence failed/);
		assert.ok(ctx.calls.task.includes("generate-1"));
		assert.equal(ctx.calls.task.includes("user-feedback-1"), false);
		assert.equal(ctx.calls.task.includes("exporter"), false);
	});
});

describe("open-claude-design — rejected feedback stage is not approval (#2123)", () => {
	test("a rejecting user-feedback stage fails the run without approving or exporting", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ prompt: "Design a dashboard", max_refinements: 2 },
			{
				task: (name) => {
					if (name === "user-feedback-1") throw new Error("provider 413 request_too_large");
					return undefined;
				},
			},
		);

		await assert.rejects(() => d.run(ctx), /request_too_large/);
		assert.ok(ctx.calls.task.includes("generate-1"));
		assert.ok(ctx.calls.task.includes("user-feedback-1"));
		assert.equal(ctx.calls.task.includes("generate-2"), false);
		assert.equal(ctx.calls.task.includes("exporter"), false);
		assert.equal(ctx.calls.task.includes("final-display"), false);
	});

	test("a resolved degraded feedback report with no notes still approves", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ prompt: "Design a dashboard", max_refinements: 2 },
			{
				task: (name) => {
					if (name.startsWith("user-feedback-")) return ["display_method: manual", "user_notes: none"].join("\n");
					return undefined;
				},
			},
		);

		const result = await d.run(ctx);

		assert.equal(result.approved_for_export, true);
		assert.ok(ctx.calls.task.includes("exporter"));
		const artifactDir = result.artifact_dir as string;
		rmSync(artifactDir, { recursive: true, force: true });
	});
});
