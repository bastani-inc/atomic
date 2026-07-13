import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { usageRollupFromModelAttempts, usageRollupFromResults } from "../../packages/subagents/src/shared/usage-rollup.js";

function atomicUsage(input: number, cost: number): Usage {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function scalarUsage(input: number, cost: number) {
	return { input, output: 0, cacheRead: 0, cacheWrite: 0, cost, turns: 1 };
}

function writeSession(path: string, input: number, cost: number, rawSuffix = ""): void {
	const entries = [
		{ type: "session", id: "session", cwd: process.cwd(), timestamp: new Date().toISOString() },
		{ type: "message", id: "message", timestamp: new Date().toISOString(), message: { role: "assistant", usage: atomicUsage(input, cost), content: [] } },
	];
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n${rawSuffix}`);
}

test("terminal result rollups keep scalar usage above a stale session file", () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-terminal-usage-floor-"));
	try {
		const sessionFile = join(dir, "session.jsonl");
		writeSession(sessionFile, 2, 0.2);
		const rollup = usageRollupFromResults([
			{ agent: "worker", task: "task", exitCode: 0, sessionFile, usage: scalarUsage(12, 1.2) },
		]);
		assert.equal(rollup.usage.input, 12);
		assert.equal(rollup.usage.cost.total, 1.2);
		assert.equal(rollup.complete, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("attempt-backed rollups keep scalar usage above a stale session file", () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-attempt-usage-floor-"));
	try {
		const sessionFile = join(dir, "session.jsonl");
		writeSession(sessionFile, 3, 0.3);
		const rollup = usageRollupFromModelAttempts([{ sessionFile, usage: scalarUsage(15, 1.5) }]);
		assert.equal(rollup.usage.input, 15);
		assert.equal(rollup.usage.cost.total, 1.5);
		assert.equal(rollup.complete, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});


test("terminal scalar floors survive malformed session tails", () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-malformed-usage-floor-"));
	try {
		const sessionFile = join(dir, "session.jsonl");
		writeSession(sessionFile, 2, 0.2, "{malformed\n");
		const resultRollup = usageRollupFromResults([
			{ agent: "worker", task: "task", exitCode: 0, sessionFile, usage: scalarUsage(12, 1.2) },
		]);
		const attemptRollup = usageRollupFromModelAttempts([{ sessionFile, usage: scalarUsage(12, 1.2) }]);
		for (const rollup of [resultRollup, attemptRollup]) {
			assert.equal(rollup.usage.input, 12);
			assert.equal(rollup.usage.cost.total, 1.2);
			assert.equal(rollup.complete, false);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("equivalent session-file aliases are counted once", () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-result-alias-"));
	try {
		const sessionFile = join(dir, "session.jsonl");
		const nestedDir = join(dir, "nested");
		mkdirSync(nestedDir);
		writeSession(sessionFile, 5, 0.5);
		const aliased = join(nestedDir, "..", "session.jsonl");
		const smaller = { agent: "worker", task: "task", exitCode: 0, usage: scalarUsage(1, 0.1) };
		const larger = { agent: "worker", task: "task", exitCode: 0, usage: scalarUsage(9, 0.9) };
		for (const results of [
			[{ ...smaller, sessionFile }, { ...larger, sessionFile: aliased }],
			[{ ...larger, sessionFile: aliased }, { ...smaller, sessionFile }],
		]) {
			const rollup = usageRollupFromResults(results);
			assert.equal(rollup.usage.input, 9);
			assert.equal(rollup.usage.cost.total, 0.9);
			assert.equal(rollup.complete, false);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
