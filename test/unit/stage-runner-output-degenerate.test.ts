import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { finalizePromptOutput } from "../../packages/workflows/src/runs/foreground/stage-runner-output.js";

async function runOutputCase(text: string): Promise<{ receipt: string; outputPath: string; transcriptPath?: string }> {
	const directory = await mkdtemp(join(tmpdir(), "stage-runner-output-degenerate-"));
	const outputPath = join(directory, "report.md");
	const receipt = await finalizePromptOutput(
		text,
		{ output: outputPath, outputMode: "file-only" },
		process.cwd(),
		`degenerate-test-${Date.now()}-${Math.random()}`,
	);
	const transcriptMatch = receipt.match(/Transcript saved to: ([^ ]+) \(/);
	return { receipt, outputPath, ...(transcriptMatch?.[1] ? { transcriptPath: transcriptMatch[1] } : {}) };
}

async function cleanupOutputCase(result: { outputPath: string; transcriptPath?: string }): Promise<void> {
	await rm(result.outputPath.slice(0, result.outputPath.lastIndexOf("/")), { recursive: true, force: true });
	if (result.transcriptPath !== undefined) await rm(result.transcriptPath, { force: true });
}

test("warns when a single-line artifact is only a common pointer to its output path", async () => {
	for (const text of ["Done. report.md", "the report is at report.md"]) {
		const result = await runOutputCase(text);
		try {
			assert.match(result.receipt, /only points to its own output path/);
			assert.equal(await readFile(result.outputPath, "utf8"), text);
		} finally {
			await cleanupOutputCase(result);
		}
	}
});

test("does not warn when short substantive output mentions its own filename", async () => {
	for (const text of [
		"Report summary: report.md contains the approved findings and validation evidence.",
		"report.md: approved findings, tests passed, no blockers.",
	]) {
		const result = await runOutputCase(text);
		try {
			assert.doesNotMatch(result.receipt, /WARNING:/);
			assert.equal(await readFile(result.outputPath, "utf8"), text);
		} finally {
			await cleanupOutputCase(result);
		}
	}
});
