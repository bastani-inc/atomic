import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@bastani/atomic";
import { test } from "vitest";
import { finalizePromptOutput } from "../../packages/workflows/src/runs/foreground/stage-runner-output.js";

async function runOutputCase(
	text: string,
	messages?: AgentSession["messages"],
): Promise<{ receipt: string; outputPath: string; transcriptPath?: string }> {
	const directory = await mkdtemp(join(tmpdir(), "stage-runner-output-degenerate-"));
	const outputPath = join(directory, "report.md");
	const receipt = await finalizePromptOutput(
		text,
		{ output: outputPath, outputMode: "file-only" },
		process.cwd(),
		`degenerate-test-${Date.now()}-${Math.random()}`,
		messages,
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

test("warns when substantially larger post-admission assistant content was discarded", async () => {
	const stageOwn = "OWN".padEnd(18, ".");
	const postAdmission = "POST".padEnd(155, ".");
	const messages = [
		{ role: "assistant", content: [{ type: "text", text: stageOwn }] },
		{ role: "custom", stageAdmissionKey: "subagent:1", content: "external result" },
		{ role: "assistant", content: [{ type: "text", text: postAdmission }] },
	] as AgentSession["messages"];
	const result = await runOutputCase(stageOwn, messages);
	try {
		assert.match(
			result.receipt,
			/WARNING: the stage's own turn was persisted; larger post-admission assistant content exists\./,
		);
		assert.ok(result.transcriptPath);
		assert.match(result.receipt, new RegExp(`Search the companion transcript at ${result.transcriptPath}`));
		assert.equal(await readFile(result.outputPath, "utf8"), stageOwn);
	} finally {
		await cleanupOutputCase(result);
	}
});

test("uses a 3:2 UTF-8 byte threshold only for the post-admission warning", async () => {
	for (const postAdmissionBytes of [149, 150]) {
		const stageOwn = "OWN".padEnd(100, ".");
		const postAdmission = "POST".padEnd(postAdmissionBytes, ".");
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: stageOwn }] },
			{ role: "custom", stageAdmissionKey: "subagent:1", content: "external result" },
			{ role: "assistant", content: [{ type: "text", text: postAdmission }] },
		] as AgentSession["messages"];
		const result = await runOutputCase(stageOwn, messages);
		try {
			if (postAdmissionBytes === 150) assert.match(result.receipt, /larger post-admission assistant content/);
			else assert.doesNotMatch(result.receipt, /larger post-admission assistant content/);
		} finally {
			await cleanupOutputCase(result);
		}
	}
});

test("warns when the no-pre-admission fallback discards a later, substantially larger turn", async () => {
	const fallback = "FALLBACK".padEnd(18, ".");
	const later = "LATER".padEnd(155, ".");
	const messages = [
		{ role: "custom", stageAdmissionKey: "subagent:1", content: "external result" },
		{ role: "assistant", content: [{ type: "text", text: fallback }] },
		{ role: "assistant", content: [{ type: "text", text: later }] },
	] as AgentSession["messages"];
	const result = await runOutputCase(fallback, messages);
	try {
		assert.match(result.receipt, /larger post-admission assistant content/);
		assert.equal(await readFile(result.outputPath, "utf8"), fallback);
	} finally {
		await cleanupOutputCase(result);
	}
});
