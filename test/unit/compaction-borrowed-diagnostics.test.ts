/**
 * RFC §5.4 / §7.1 — the borrowed planner identity has to reach diagnostics, not
 * just the durable entry. The RFC defines no success payload; the chosen shape
 * is `SuccessDiagnostic` written to `<session>-compaction-success-<ts>.json`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { runVerbatimCompaction } from "../../packages/coding-agent/src/core/compaction/compaction-runner.js";
import type { SuccessDiagnostic } from "../../packages/coding-agent/src/core/compaction/range-planner-diagnostics.js";
import { preparation, registryOf, runRequest, scriptedStream, testModel } from "./compaction-rung-support.js";

const primary = testModel();
const fallback = testModel({ provider: "backup", id: "planner-b", baseUrl: "https://backup.example" });
const posixMode = process.platform === "win32" ? test.skip : test;

function sidecars(directory: string, marker: string): string[] {
	return readdirSync(directory)
		.filter((name) => name.includes(marker))
		.map((name) => join(directory, name));
}

async function rescuedRun(sessionFilePath: string) {
	const stream = scriptedStream({
		"planner-a": [{ errorMessage: "429 Too Many Requests" }],
		"planner-b": [{ text: "1,10\n" }],
	});
	return runVerbatimCompaction(
		preparation(),
		primary,
		runRequest({
			streamFn: stream.streamFn,
			sessionFilePath,
			resolveAuth: async (model) => ({ apiKey: `${model.provider}-key` }),
			fallback: {
				fallbackModels: ["backup/planner-b"],
				registry: registryOf([primary, fallback]),
				preferredProvider: "primary",
				sessionThinkingLevel: "high",
			},
		}),
	);
}

test("a borrowed planned success leaves per-model evidence in diagnostics", async () => {
	const directory = mkdtempSync(join(tmpdir(), "compaction-borrowed-"));
	try {
		const result = await rescuedRun(join(directory, "session.jsonl"));
		assert.equal(result.rung, "planned");
		assert.deepEqual(result.plannerModel, { provider: "backup", id: "planner-b", thinkingLevel: "high" });

		// The primary's failure sidecar identifies the primary.
		const failures = sidecars(directory, "compaction-diagnostic");
		assert.equal(failures.length, 1);
		const failure = JSON.parse(readFileSync(failures[0], "utf-8")) as {
			failureCategory: string;
			model: { provider: string; id: string };
		};
		assert.equal(failure.failureCategory, "rate_limited");
		assert.equal(failure.model.id, "planner-a");

		// The success sidecar identifies the model that actually ranked the lines.
		const successes = sidecars(directory, "compaction-success");
		assert.equal(successes.length, 1);
		const success = JSON.parse(readFileSync(successes[0], "utf-8")) as SuccessDiagnostic;
		assert.equal(success.version, 1);
		assert.equal(success.successCategory, "borrowed_planner");
		assert.equal(success.model.provider, "backup");
		assert.equal(success.model.id, "planner-b");
		assert.equal(success.thinkingLevel, "high");
		assert.equal(success.requestMaxTokens, undefined);

		// Durable metadata and the sidecar agree.
		assert.equal(success.model.provider, result.plannerModel?.provider);
		assert.equal(success.model.id, result.plannerModel?.id);
		assert.equal(success.thinkingLevel, result.plannerModel?.thinkingLevel);

		for (const file of [...failures, ...successes]) {
			const raw = readFileSync(file, "utf-8");
			assert.ok(!raw.includes("apiKey"), `${file} leaked an apiKey field`);
			assert.ok(!raw.includes("-key"), `${file} leaked a credential value`);
			assert.ok(!raw.includes("headers"), `${file} leaked headers`);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

posixMode("the success sidecar is owner-only", async () => {
	const directory = mkdtempSync(join(tmpdir(), "compaction-borrowed-mode-"));
	try {
		await rescuedRun(join(directory, "session.jsonl"));
		for (const file of sidecars(directory, "compaction-success")) {
			assert.equal(statSync(file).mode & 0o777, 0o600);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a session-model success writes no borrowed-planner sidecar", async () => {
	const directory = mkdtempSync(join(tmpdir(), "compaction-unborrowed-"));
	try {
		const stream = scriptedStream({ default: [{ text: "1,10\n" }] });
		const result = await runVerbatimCompaction(
			preparation(),
			primary,
			runRequest({ streamFn: stream.streamFn, sessionFilePath: join(directory, "session.jsonl") }),
		);
		assert.equal(result.plannerModel, undefined);
		assert.deepEqual(sidecars(directory, "compaction-success"), []);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("an unwritable sidecar path never fails the rescued compaction", async () => {
	const result = await rescuedRun("/no/such/dir/session.jsonl");
	assert.equal(result.rung, "planned");
	assert.deepEqual(result.plannerModel, { provider: "backup", id: "planner-b", thinkingLevel: "high" });
});

test("an in-memory session writes no sidecars but still borrows", async () => {
	const stream = scriptedStream({
		"planner-a": [{ errorMessage: "429 Too Many Requests" }],
		"planner-b": [{ text: "1,10\n" }],
	});
	const result = await runVerbatimCompaction(
		preparation(),
		primary,
		runRequest({
			streamFn: stream.streamFn,
			resolveAuth: async (model) => ({ apiKey: `${model.provider}-key` }),
			fallback: {
				fallbackModels: ["backup/planner-b"],
				registry: registryOf([primary, fallback]),
				preferredProvider: "primary",
				sessionThinkingLevel: "high",
			},
		}),
	);
	assert.equal(result.rung, "planned");
	assert.equal(result.plannerModel?.id, "planner-b");
});
