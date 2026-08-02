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
	promptStartIndex?: number,
): Promise<{ receipt: string; outputPath: string; transcriptPath?: string }> {
	const directory = await mkdtemp(join(tmpdir(), "stage-runner-output-degenerate-"));
	const outputPath = join(directory, "report.md");
	const receipt = await finalizePromptOutput(
		text,
		{ output: outputPath, outputMode: "file-only" },
		process.cwd(),
		`degenerate-test-${Date.now()}-${Math.random()}`,
		messages,
		promptStartIndex,
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

test("warns whenever non-empty post-admission assistant content was discarded", async () => {
	const stageOwn = "OWN".padEnd(100, ".");
	const postAdmission = "POST".padEnd(101, ".");
	const messages = [
		{ role: "assistant", content: [{ type: "text", text: stageOwn }] },
		{ role: "custom", stageAdmissionKey: "subagent:1", content: "external result" },
		{ role: "assistant", content: [{ type: "text", text: postAdmission }] },
	] as AgentSession["messages"];
	const result = await runOutputCase(stageOwn, messages);
	try {
		assert.match(
			result.receipt,
			/WARNING: the stage's own pre-admission turn was persisted; post-admission assistant content was discarded\./,
		);
		assert.ok(result.transcriptPath);
		assert.match(result.receipt, new RegExp(`Search the companion transcript at ${result.transcriptPath}`));
		assert.equal(await readFile(result.outputPath, "utf8"), stageOwn);
		assert.match(await readFile(result.transcriptPath, "utf8"), new RegExp(postAdmission));
	} finally {
		await cleanupOutputCase(result);
	}
});

test("has no silent size band for discarded post-admission assistant content", async () => {
	for (const postAdmissionBytes of [4, 99, 100, 101, 150]) {
		const stageOwn = "OWN".padEnd(100, ".");
		const postAdmission = "POST".padEnd(postAdmissionBytes, ".");
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: stageOwn }] },
			{ role: "custom", stageAdmissionKey: "subagent:1", content: "external result" },
			{ role: "assistant", content: [{ type: "text", text: postAdmission }] },
		] as AgentSession["messages"];
		const result = await runOutputCase(stageOwn, messages);
		try {
			assert.match(result.receipt, /post-admission assistant content was discarded/);
		} finally {
			await cleanupOutputCase(result);
		}
	}
});

test("warns from the no-pre-admission fallback without claiming stage-own text was persisted", async () => {
	const acknowledgement = "ACK";
	const report = "REPORT".padEnd(155, ".");
	const messages = [
		{ role: "custom", stageAdmissionKey: "subagent:1", content: "external result" },
		{ role: "assistant", content: [{ type: "text", text: acknowledgement }] },
		{ role: "assistant", content: [{ type: "text", text: report }] },
	] as AgentSession["messages"];
	const result = await runOutputCase(report, messages, 0);
	try {
		assert.match(
			result.receipt,
			/WARNING: no stage-own assistant text existed before the admission; a post-admission assistant turn was selected and other post-admission assistant content was discarded\./,
		);
		assert.doesNotMatch(result.receipt, /stage's own .* was persisted/);
		assert.ok(result.transcriptPath);
		const transcript = await readFile(result.transcriptPath, "utf8");
		assert.match(transcript, /ACK/);
		assert.match(transcript, /REPORT/);
		assert.equal(await readFile(result.outputPath, "utf8"), report);
	} finally {
		await cleanupOutputCase(result);
	}
});

test("scopes discarded-content warnings to the current prompt window", async () => {
	const firstAnswer = "P1 answer";
	const firstAcknowledgement = "P1 ack";
	const secondIntroduction = "P2 intro".padEnd(120, ".");
	const report = "REAL REPORT".padEnd(21_000, ".");
	const messages = [
		{ role: "assistant", content: [{ type: "text", text: firstAnswer }] },
		{ role: "custom", stageAdmissionKey: "subagent:1", content: "first external result" },
		{ role: "assistant", content: [{ type: "text", text: firstAcknowledgement }] },
		{ role: "assistant", content: [{ type: "text", text: secondIntroduction }] },
		{ role: "custom", stageAdmissionKey: "subagent:2", content: "second external result" },
		{ role: "assistant", content: [{ type: "text", text: report }] },
	] as AgentSession["messages"];
	const result = await runOutputCase(secondIntroduction, messages, 3);
	try {
		assert.match(result.receipt, /stage's own pre-admission turn was persisted/);
		assert.ok(result.transcriptPath);
		assert.match(await readFile(result.transcriptPath, "utf8"), /REAL REPORT/);
		assert.equal(await readFile(result.outputPath, "utf8"), secondIntroduction);
	} finally {
		await cleanupOutputCase(result);
	}
});
