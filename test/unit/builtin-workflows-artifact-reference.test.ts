// @ts-nocheck

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

/**
 * Terminal-artifact contract for the pattern workflows.
 *
 * A workflow's `result` is returned into the caller's context window, so it
 * must stay a compact artifact reference. Two ways that regressed before:
 * declaring `output` without `outputMode: "file-only"` (the runner then
 * returns the full text plus a reference), and setting `file-only` but reading
 * the artifact back with `readFile` before returning it, which cancels the
 * saving. Each case is caught below by making the terminal stage's returned
 * text differ from the bytes on disk: `result` must carry the returned
 * reference, never the file body.
 */
describe("pattern workflow terminal artifacts stay references", () => {
	let tempCwd = "";
	beforeEach(() => {
		tempCwd = mkdtempSync(join(tmpdir(), "atomic-artifact-ref-"));
	});
	afterEach(() => {
		rmSync(tempCwd, { recursive: true, force: true });
	});

	const SENTINEL = "ARTIFACT-REFERENCE-SENTINEL";

	/** Force one stage to return a reference that is not what the mock wrote to disk. */
	function stubTerminalText(ctx, isTerminal) {
		const originalTask = ctx.task.bind(ctx);
		Object.defineProperty(ctx, "task", {
			value: async (name, options) => {
				const result = await originalTask(name, options);
				return isTerminal(name) ? { ...result, text: `${SENTINEL} ${String(options.output)}` } : result;
			},
		});
		return ctx;
	}

	function assertReferenceOnly(result, artifactPath, stageOptions) {
		assert.equal(stageOptions?.outputMode, "file-only", "terminal stage must declare file-only output");
		assert.match(result, new RegExp(SENTINEL), "result must carry the artifact reference");
		const body = readFileSync(artifactPath, "utf8");
		assert.equal(body.includes(SENTINEL), false, "artifact file holds the report, not the reference");
		assert.equal(result.includes(body), false, "result must not inline the artifact body");
	}

	test("classify-and-act returns the action artifact by reference", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/classify-and-act.js");
		const ctx = stubTerminalText(
			Object.assign(
				makeMockCtx(
					{ prompt: "Analyze the parser", categories: ["analysis", "implementation"], confidence_threshold: 0.5 },
					{
						task: (name) =>
							name === "classifier"
								? JSON.stringify({ category: "analysis", confidence: 0.95, rationale: "clear" })
								: undefined,
					},
				),
				{ cwd: tempCwd },
			),
			(name) => name.startsWith("action-"),
		);

		const output = await definition.run(ctx);
		assertReferenceOnly(output.result, output.action_path, ctx.calls.taskOptions["action-analysis"]?.[0]);
	});

	test("fan-out-and-synthesize returns the synthesis artifact by reference", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/fan-out-and-synthesize.js");
		const ctx = stubTerminalText(
			Object.assign(
				makeMockCtx(
					{ prompt: "Map the runtime", max_branches: 2, max_concurrency: 2 },
					{
						task: (name) =>
							name === "partition"
								? JSON.stringify({
										partitions: [
											{ label: "one", objective: "first" },
											{ label: "two", objective: "second" },
										],
									})
								: undefined,
					},
				),
				{ cwd: tempCwd },
			),
			(name) => name === "synthesize",
		);

		const output = await definition.run(ctx);
		assertReferenceOnly(output.result, output.synthesis_path, ctx.calls.taskOptions.synthesize?.[0]);
	});

	test("tournament returns the reducer artifact by reference", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/tournament.js");
		const ctx = stubTerminalText(
			Object.assign(
				makeMockCtx(
					{ prompt: "Design a safe migration", num_attempts: 2, max_concurrency: 2 },
					{
						task: (name) =>
							name.startsWith("judge-")
								? JSON.stringify({ winner: "first", rationale: "rubric", evidence: ["observable evidence"] })
								: undefined,
					},
				),
				{ cwd: tempCwd },
			),
			(name) => name === "bracket-reducer",
		);

		const output = await definition.run(ctx);
		assertReferenceOnly(output.result, output.result_path, ctx.calls.taskOptions["bracket-reducer"]?.[0]);
	});

	test("loop-until-done returns the completion artifact by reference", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/loop-until-done.js");
		const ctx = stubTerminalText(
			Object.assign(
				makeMockCtx(
					{ prompt: "Get the suite green", max_iterations: 2 },
					{
						task: (name) =>
							name.startsWith("evaluate-")
								? JSON.stringify({
										done: true,
										summary: "criteria met",
										new_findings: [],
										failures: [],
										validation_evidence: ["suite green"],
										remaining_work: "",
									})
								: undefined,
					},
				),
				{ cwd: tempCwd },
			),
			(name) => name === "completion-summary",
		);

		const output = await definition.run(ctx);
		assert.equal(output.status, "complete");
		assertReferenceOnly(output.result, output.result_path, ctx.calls.taskOptions["completion-summary"]?.[0]);
	});
});
