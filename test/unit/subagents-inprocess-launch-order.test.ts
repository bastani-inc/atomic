import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { createSubagentControl } from "../../packages/subagents/src/runs/inprocess/runner.ts";

/** A path whose `stat`, or text whose `appendFile` or `writeFile`, waits for `release`, so the next one finishes first. */
const slow = vi.hoisted(() => ({
	statPath: undefined as string | undefined,
	appendText: undefined as string | undefined,
	writeText: undefined as string | undefined,
	release: undefined as Promise<void> | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const stat = (async (...args: Parameters<typeof actual.stat>) => {
		if (slow.statPath !== undefined && String(args[0]) === slow.statPath) await slow.release;
		return actual.stat(...args);
	}) as typeof actual.stat;
	const appendFile = (async (...args: Parameters<typeof actual.appendFile>) => {
		if (slow.appendText !== undefined && String(args[1]).includes(slow.appendText)) await slow.release;
		return actual.appendFile(...args);
	}) as typeof actual.appendFile;
	const writeFile = (async (...args: Parameters<typeof actual.writeFile>) => {
		if (slow.writeText !== undefined && String(args[1]).includes(slow.writeText)) await slow.release;
		return actual.writeFile(...args);
	}) as typeof actual.writeFile;
	return {
		...actual,
		stat,
		appendFile,
		writeFile,
		default: { ...actual, stat, appendFile, writeFile },
	};
});

const roots: string[] = [];

afterEach(() => {
	slow.statPath = undefined;
	slow.appendText = undefined;
	slow.writeText = undefined;
	slow.release = undefined;
	clearSubagentControls();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function agent(): AgentConfig {
	return {
		name: "analysis",
		description: "analysis agent",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/analysis.md",
	};
}

test("a run's children are numbered in the order they were launched, whichever cwd check finishes first", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-admission-order-"));
	roots.push(root);
	const cwds = [join(root, "first"), join(root, "second")];
	for (const cwd of cwds) mkdirSync(cwd);
	const released = Promise.withResolvers<void>();
	slow.statPath = cwds[0];
	slow.release = released.promise;
	clearSubagentControls();

	const launches = cwds.map((cwd, index) =>
		runSingleInProcess(root, agent(), `inspect fixture ${index}`, {
			cwd,
			runId: "order-parent",
			index,
			sessionDir: join(root, "sessions", `run-${index}`),
			testSession: { output: `result ${index}` },
		}),
	);
	// The second launch has checked its cwd and waits for the first, which has not.
	await new Promise((resolve) => setTimeout(resolve, 50));
	released.resolve();
	const results = await Promise.all(launches);

	assert.deepEqual(
		results.map((result) => result.status),
		["ok", "ok"],
	);
	assert.deepEqual(
		results.map((result) => result.path),
		["order-parent/analysis_1", "order-parent/analysis_2"],
	);
});

test.each([
	["its history line", "appendText", '"path":"history-parent/first"'],
	["its output", "writeText", "first result"],
] as const)(
	"a run's history lists its children's results in the order they were delivered, when writing %s is slow",
	async (_slowStep, field, text) => {
		const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-history-order-"));
		roots.push(root);
		const artifactsDir = join(root, "artifacts");
		const control = createSubagentControl({ path: "history-parent", depth: 0 }, join(root, "sessions"));
		const stats = {
			sessionFile: undefined,
			sessionId: "child-session",
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 2,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		};
		const released = Promise.withResolvers<void>();
		slow[field] = text;
		slow.release = released.promise;

		const deliveries = ["first", "second"].map((name, index) =>
			control.deliverChildResult({
				path: `history-parent/${name}`,
				status: "ok",
				stats,
				envelope: `${name} result`,
				timestamp: index,
				artifactsDir,
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		released.resolve();
		await Promise.all(deliveries);

		const history = readFileSync(join(artifactsDir, "run-history.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as { path: string }).path);
		assert.deepEqual(history, ["history-parent/first", "history-parent/second"]);
	},
);
