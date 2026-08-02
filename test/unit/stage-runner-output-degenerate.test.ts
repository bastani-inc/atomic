import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@bastani/atomic";
import { test } from "vitest";
import { finalizePromptOutput } from "../../packages/workflows/src/runs/foreground/stage-runner-output.js";

async function runOutputCase(
	text: string | ((outputPath: string) => string),
	messages?: AgentSession["messages"],
	promptStartIndex?: number,
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
		promptStartIndex,
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

test("warns when an artifact is empty or only points to its own output path", async () => {
	for (const text of ["", "   "]) {
		const result = await runOutputCase(text);
		try {
			assert.match(result.receipt, /artifact is empty/);
			assert.equal(await readFile(result.outputPath, "utf8"), text);
		} finally {
			await cleanupOutputCase(result);
		}
	}
	const pointers: readonly (string | ((outputPath: string) => string))[] = [
		"report.md",
		(outputPath) => outputPath,
		(outputPath) => `See ${outputPath}`,
		"See the report at report.md",
		"Research complete, saved to report.md",
		(outputPath) => `Report saved to ${outputPath}`,
		"Done. report.md",
		"The report is at report.md",
		"Output written to report.md",
		"Wrote report.md",
		"Saved: report.md",
		"I have written the research report to report.md.",
		"The full research report is now available at report.md - please read it.",
	];
	for (const text of pointers) {
		const result = await runOutputCase(text);
		try {
			assert.match(result.receipt, /only points to its own output path/, result.fullOutput);
			assert.equal(await readFile(result.outputPath, "utf8"), result.fullOutput);
		} finally {
			await cleanupOutputCase(result);
		}
	}
});

test("does not warn when genuine output mentions its own filename", async () => {
	for (const text of [
		"Report summary: report.md contains the approved findings and validation evidence.",
		"report.md: approved findings, tests passed, no blockers.",
		"Finding: report.md records the retry-race fix; all 12 focused tests pass.",
		"# Findings\n\nThe report path is report.md for downstream readers.\n\nThe retry race is fixed and validated.",
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

test("does not warn when the only passed-over post-admission content is a terse acknowledgement", async () => {
	const stageOwn = "OWN".padEnd(100, ".");
	const acknowledgement = "ACK".padEnd(25, ".");
	const messages = [
		{ role: "assistant", content: [{ type: "text", text: stageOwn }] },
		{ role: "custom", stageAdmissionKey: "subagent:1", content: "external result" },
		{ role: "assistant", content: [{ type: "text", text: acknowledgement }] },
	] as AgentSession["messages"];
	const result = await runOutputCase(stageOwn, messages);
	try {
		assert.doesNotMatch(result.receipt, /post-admission assistant content was discarded/);
		assert.equal(await readFile(result.outputPath, "utf8"), stageOwn);
	} finally {
		await cleanupOutputCase(result);
	}
});

test("warns whenever plausibly substantive post-admission content is passed over", async () => {
	for (const postAdmissionBytes of [26, 99, 100, 101, 149]) {
		const stageOwn = "OWN".padEnd(100, ".");
		const postAdmission = "POST".padEnd(postAdmissionBytes, ".");
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
			assert.match(await readFile(result.transcriptPath, "utf8"), new RegExp(postAdmission));
		} finally {
			await cleanupOutputCase(result);
		}
	}
});

test("uses recency above the floor and warns when the fallback passes over substantive text", async () => {
	const verboseAcknowledgement = "ACK".padEnd(30_000, ".");
	const shortDeliverable = "short but real deliverable";
	const messages = [
		{ role: "custom", stageAdmissionKey: "subagent:1", content: "external result" },
		{ role: "assistant", content: [{ type: "text", text: verboseAcknowledgement }] },
		{ role: "assistant", content: [{ type: "text", text: shortDeliverable }] },
	] as AgentSession["messages"];
	const result = await runOutputCase(shortDeliverable, messages, 0);
	try {
		assert.match(
			result.receipt,
			/WARNING: no stage-own assistant text existed before the admission; a post-admission assistant turn was selected and other post-admission assistant content was discarded\./,
		);
		assert.doesNotMatch(result.receipt, /stage's own .* was persisted/);
		assert.ok(result.transcriptPath);
		const transcript = await readFile(result.transcriptPath, "utf8");
		assert.match(transcript, /ACK/);
		assert.match(transcript, /short but real deliverable/);
		assert.equal(await readFile(result.outputPath, "utf8"), shortDeliverable);
	} finally {
		await cleanupOutputCase(result);
	}
});

test("scopes override warnings to the current prompt window", async () => {
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
	const result = await runOutputCase(report, messages, 3);
	try {
		assert.match(
			result.receipt,
			/WARNING: a substantially larger post-admission assistant turn was persisted; the pre-admission assistant turn was discarded\./,
		);
		assert.ok(result.transcriptPath);
		assert.match(result.receipt, new RegExp(`Search the companion transcript at ${result.transcriptPath}`));
		assert.match(await readFile(result.transcriptPath, "utf8"), /REAL REPORT/);
		assert.equal(await readFile(result.outputPath, "utf8"), report);
	} finally {
		await cleanupOutputCase(result);
	}
});
