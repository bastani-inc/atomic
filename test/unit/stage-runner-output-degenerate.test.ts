import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@bastani/atomic";
import { test } from "vitest";
import {
	finalizePromptOutput,
	stageOutputInstruction,
} from "../../packages/workflows/src/runs/foreground/stage-runner-output.js";

/**
 * The stage-output receipt reports facts only.
 *
 * An earlier revision tried to classify a non-empty artifact as a "pointer" or
 * an "acknowledgement" through byte-size ratios and a bank of English-phrasing
 * regexes. That is an inference about intent, it cannot be made correctly, and
 * it produced false alarms on short genuine deliverables while staying silent
 * on the failure that mattered. The companion transcript named in every receipt
 * is the recovery path instead.
 */

async function runOutputCase(
	text: string | ((outputPath: string) => string),
	messages?: AgentSession["messages"],
): Promise<{ receipt: string; outputPath: string; fullOutput: string; transcriptPath?: string }> {
	const directory = await mkdtemp(join(tmpdir(), "stage-runner-output-degenerate-"));
	const outputPath = join(directory, "report.md");
	const fullOutput = typeof text === "function" ? text(outputPath) : text;
	const receipt = await finalizePromptOutput(
		fullOutput,
		{ output: outputPath, outputMode: "file-only" },
		process.cwd(),
		`degenerate-test-${Date.now()}-${Math.random()}`,
		messages,
	);
	const transcriptMatch = receipt.match(/Transcript saved to: ([^ ]+) \(/);
	return {
		receipt,
		outputPath,
		fullOutput,
		...(transcriptMatch?.[1] ? { transcriptPath: transcriptMatch[1] } : {}),
	};
}

async function cleanupOutputCase(result: { outputPath: string; transcriptPath?: string }): Promise<void> {
	await rm(result.outputPath.slice(0, result.outputPath.lastIndexOf("/")), { recursive: true, force: true });
	if (result.transcriptPath !== undefined) await rm(result.transcriptPath, { force: true });
}

test("an empty artifact is reported as empty", async () => {
	const result = await runOutputCase("   \n  ");
	try {
		assert.match(result.receipt, /WARNING: the stage artifact is empty/);
		assert.match(result.receipt, /Transcript saved to: /);
	} finally {
		await cleanupOutputCase(result);
	}
});

test("a non-empty artifact is never classified, however short", async () => {
	const result = await runOutputCase("ok");
	try {
		assert.doesNotMatch(result.receipt, /WARNING/);
		assert.equal(await readFile(result.outputPath, "utf8"), "ok");
	} finally {
		await cleanupOutputCase(result);
	}
});

test("an artifact that only names its own output path is not treated as degenerate", async () => {
	// Previously a regex bank flagged this shape. Judging it requires knowing what
	// the author meant, so the receipt stays silent and points at the transcript.
	const result = await runOutputCase((outputPath) => `Research complete, saved to ${outputPath}`);
	try {
		assert.doesNotMatch(result.receipt, /WARNING/);
		assert.match(result.receipt, /Transcript saved to: /);
	} finally {
		await cleanupOutputCase(result);
	}
});

test("every receipt names the artifact and the transcript with its access pattern", async () => {
	const result = await runOutputCase("# Report\n\nfindings\n");
	try {
		assert.match(result.receipt, /Output saved to: /);
		assert.match(result.receipt, /Transcript saved to: /);
		assert.match(result.receipt, /Search it with rg, read narrow line ranges, and do not read it whole\./);
	} finally {
		await cleanupOutputCase(result);
	}
});

test("the runtime states the artifact contract so prompts do not have to", () => {
	const withOutput = stageOutputInstruction({ output: "/tmp/report.md" });
	assert.match(withOutput, /final message is saved verbatim as its artifact/);
	assert.match(withOutput, /rather than a pointer to it/);
	assert.match(withOutput, /Files you write yourself are not the artifact/);

	// No `output:` means no artifact, so the stage prompt is left untouched.
	assert.equal(stageOutputInstruction({}), "");
	assert.equal(stageOutputInstruction({ output: "" }), "");
});
