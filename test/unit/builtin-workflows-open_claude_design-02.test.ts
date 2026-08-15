// @ts-nocheck

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import { feedbackArtifactPath } from "../../packages/workflows/builtin/open-claude-design-feedback.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import { makeMockCtx, readPathEndsWith } from "./builtin-workflows-helpers.js";

/**
 * The structured final answer the `user-feedback-*` stage returns when the
 * user wants the preview exported as it now stands. The stage declares
 * `previewFeedbackSchema`, so the mock parses this into `result.structured`.
 * cross-ref: issues #2401, #2411.
 */
const STRUCTURED_EXPORT = JSON.stringify({ decision: "export", user_notes: [], live_changes: [] });

describe("open-claude-design — one live review session per design (#1464, #2411)", () => {
	const previewWithAnnotations = JSON.stringify({
		decision: "regenerate",
		user_notes: [
			"I don't like this background; simplify it to a black to grey gradient.",
			"Make the overall vibe more polished, closer to the Apple website.",
		],
		live_changes: [],
		annotated_snapshot: ".playwright-cli/annotations-test.png",
	});

	test("a regenerate session runs exactly one generate-2 carrying the notes, then reviews again", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ prompt: "Redesign the Atomic website", max_refinements: 2 },
			{
				task: (name) => {
					if (name === "user-feedback-1") return previewWithAnnotations;
					if (name === "user-feedback-2") return STRUCTURED_EXPORT;
					return undefined;
				},
			},
		);

		const result = await d.run(ctx);

		assert.deepEqual(
			ctx.calls.task.filter((name) => name.startsWith("generate-") || name.startsWith("user-feedback-")),
			["generate-1", "user-feedback-1", "generate-2", "user-feedback-2"],
		);
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
					if (name === "user-feedback-2") return STRUCTURED_EXPORT;
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
					if (name === "user-feedback-3") return STRUCTURED_EXPORT;
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

	test("a session that returns export runs no generate-2 and reaches the exporter", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ prompt: "Design a dashboard", max_refinements: 2 },
			{
				task: (name) => {
					if (name === "user-feedback-1") return STRUCTURED_EXPORT;
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
	const previewWithAnnotations = JSON.stringify({
		decision: "regenerate",
		user_notes: ["Tighten the hero spacing."],
		live_changes: [],
	});

	test("raises a run-level ui.select naming the preview before each user-feedback stage", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ prompt: "Design a dashboard", max_refinements: 2 },
			{
				task: (name) => {
					if (name === "user-feedback-1") return previewWithAnnotations;
					if (name === "user-feedback-2") return STRUCTURED_EXPORT;
					return undefined;
				},
			},
		);

		const result = await d.run(ctx);

		assert.equal(ctx.calls.uiSelects.length, 2);
		const gate = ctx.calls.uiSelects[0];
		assert.match(gate.message, /review session 1 /i);
		assert.ok(gate.message.includes(result.preview_path as string));
		assert.ok(gate.message.includes(result.preview_file_url as string));
		assert.ok(gate.message.includes("/workflow connect"));
		assert.deepEqual([...gate.options], ["Start live review", "Skip remaining review rounds and export as-is"]);
		assert.match(ctx.calls.uiSelects[1].message, /review session 2 /i);
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
					if (name.startsWith("user-feedback-")) return STRUCTURED_EXPORT;
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

	test("a resolved degraded review session that returns export still exports", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ prompt: "Design a dashboard", max_refinements: 2 },
			{
				task: (name) => {
					// A manual/degraded review still finalizes the declared structured
					// answer; it is the `decision`, not the prose, that exports.
					if (name.startsWith("user-feedback-")) return STRUCTURED_EXPORT;
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

/**
 * A finalized structured feedback result remains authoritative even when a
 * continuation would otherwise replace the stage's visible text.
 * cross-ref: issue #2401.
 */
describe("open-claude-design — structured feedback deliverable (#2401)", () => {
	const STRUCTURED_REGENERATION = {
		decision: "regenerate",
		user_notes: ["The hero background is too busy; simplify it to a black-to-grey gradient."],
		live_changes: ["Accepted variant 2 for the pricing table."],
	};
	const CONTINUATION_WRAP_UP = "All set — the live review session is closed and the preview is ready.";

	test("a regenerate session starts generate-2 even when a continuation replaced the final text", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ prompt: "Redesign the Atomic website", max_refinements: 2 },
			{
				task: (name) => {
					if (name === "user-feedback-1") {
						return { text: CONTINUATION_WRAP_UP, structured: STRUCTURED_REGENERATION };
					}
					if (name === "user-feedback-2") return STRUCTURED_EXPORT;
					return undefined;
				},
			},
		);

		const result = await d.run(ctx);

		assert.ok(ctx.calls.task.includes("generate-2"));
		assert.equal(result.approved_for_export, true);
		assert.ok(ctx.calls.task.includes("exporter"));

		const artifactDir = result.artifact_dir as string;
		const artifactPath = feedbackArtifactPath(artifactDir, 1);
		const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
		assert.equal(artifact.decision, "regenerate");
		assert.deepEqual(artifact.user_notes, STRUCTURED_REGENERATION.user_notes);
		assert.deepEqual(artifact.live_changes, STRUCTURED_REGENERATION.live_changes);
		assert.deepEqual(Object.keys(artifact.meta).sort(), ["captured_at", "iteration", "stage_name"]);

		const generatePrompt = ctx.calls.prompts["generate-2"]?.[0] ?? "";
		assert.ok(generatePrompt.includes(STRUCTURED_REGENERATION.user_notes[0]));
		assert.ok(generatePrompt.includes(artifactPath));
		assert.ok(readPathEndsWith(ctx.calls.taskOptions["generate-2"]?.[0], join("feedback", "iteration-1.json")));
		rmSync(artifactDir, { recursive: true, force: true });
	});

	test("a second regenerate past the budget exports and says the request was dropped", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ prompt: "Redesign the Atomic website", max_refinements: 1 },
			{
				task: (name) => {
					if (name.startsWith("user-feedback-")) {
						return { text: CONTINUATION_WRAP_UP, structured: STRUCTURED_REGENERATION };
					}
					return undefined;
				},
			},
		);

		const result = await d.run(ctx);

		// One regeneration is budgeted, so the second request stops the loop
		// rather than starting an unbounded chain.
		assert.deepEqual(
			ctx.calls.task.filter(
				(name) => name.startsWith("generate-") || name.startsWith("user-feedback-") || name === "exporter",
			),
			["generate-1", "user-feedback-1", "generate-2", "user-feedback-2", "exporter"],
		);
		assert.equal(result.approved_for_export, false);
		// The dropped regeneration is stated rather than silently discarded.
		assert.match(result.artifact as string, /regeneration budget was already spent \(max_refinements: 1\)/);

		// Every session is still persisted, and the one that asked for the
		// regeneration reached generate-2's `reads`.
		const artifactDir = result.artifact_dir as string;
		assert.ok(existsSync(feedbackArtifactPath(artifactDir, 1)));
		assert.ok(existsSync(feedbackArtifactPath(artifactDir, 2)));
		assert.ok(readPathEndsWith(ctx.calls.taskOptions["generate-2"]?.[0], join("feedback", "iteration-1.json")));
		rmSync(artifactDir, { recursive: true, force: true });
	});
});

describe("open-claude-design — the workflow owns the live poll loop (#2401 follow-up)", () => {
	const STRUCTURED_EXPORT_LOOP = JSON.stringify({ decision: "export", user_notes: [], live_changes: [] });

	/** A project whose impeccable scripts resolve, so the live-driven path is taken. */
	function makeLiveProject() {
		const dir = mkdtempSync(join(tmpdir(), "ocd-live-"));
		mkdirSync(join(dir, ".agents", "skills", "impeccable", "scripts"), { recursive: true });
		writeFileSync(join(dir, ".agents", "skills", "impeccable", "scripts", "live-poll.mjs"), "#!/usr/bin/env node\n");
		return dir;
	}

	test("polls, calls the model back per event, replies, and ends only on the helper's exit", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const cwd = makeLiveProject();
		try {
			const ctx = makeMockCtx(
				{ prompt: "Redesign the Atomic website", max_refinements: 1 },
				{
					cwd,
					task: (name) => (name === "user-feedback-1" ? STRUCTURED_EXPORT_LOOP : undefined),
					tool: (name) => {
						if (name === "live-poll-1-1")
							return { type: "generate", id: "g1", raw: '{"type":"generate","id":"g1"}' };
						if (name === "live-poll-1-2") return { type: "steer", id: "s1", raw: '{"type":"steer","id":"s1"}' };
						if (name === "live-poll-1-3") return { type: "accept", id: "a1", raw: '{"type":"accept","id":"a1"}' };
						if (name.startsWith("live-poll-")) return { type: "exit", raw: '{"type":"exit"}' };
						if (name.startsWith("live-reply-")) return { code: 0, stdout: "", stderr: "" };
						return undefined;
					},
				},
			);

			await d.run(ctx);

			// The session opens, each model-facing event gets its own stage, and the
			// structured deliverable is reported only after `exit`.
			assert.equal(ctx.calls.task.includes("user-feedback-1-start"), true);
			assert.equal(ctx.calls.task.includes("live-generate-1-1"), true);
			assert.equal(ctx.calls.task.includes("live-steer-1-2"), true);
			// `accept` is acknowledged by the poll script itself: no stage, no reply.
			assert.equal(
				ctx.calls.task.some((name) => name.startsWith("live-accept")),
				false,
			);
			assert.equal(ctx.calls.tool.includes("live-reply-1-3"), false);
			// Replies acknowledge exactly the two model-handled events.
			assert.equal(ctx.calls.tool.includes("live-reply-1-1"), true);
			assert.equal(ctx.calls.tool.includes("live-reply-1-2"), true);
			// Four polls: generate, steer, accept, then exit.
			assert.equal(ctx.calls.tool.filter((name) => name.startsWith("live-poll-")).length, 4);
			assert.equal(ctx.calls.task.includes("user-feedback-1"), true);
			assert.equal(ctx.calls.task.includes("exporter"), true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("a project without the impeccable scripts falls back to the single review stage", async () => {
		const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const cwd = mkdtempSync(join(tmpdir(), "ocd-nolive-"));
		try {
			const ctx = makeMockCtx(
				{ prompt: "Redesign the Atomic website", max_refinements: 1 },
				{ cwd, task: (name) => (name === "user-feedback-1" ? STRUCTURED_EXPORT_LOOP : undefined) },
			);

			await d.run(ctx);

			assert.equal(
				ctx.calls.tool.some((name) => name.startsWith("live-poll-")),
				false,
			);
			assert.equal(ctx.calls.task.includes("user-feedback-1-start"), false);
			assert.equal(ctx.calls.task.includes("user-feedback-1"), true);
			assert.equal(ctx.calls.task.includes("exporter"), true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
