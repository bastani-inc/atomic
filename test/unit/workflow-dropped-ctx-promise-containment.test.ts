import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, test } from "vitest";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/workflow-dropped-ctx-promise.ts");
const REAL_CHILD_TIMEOUT_MS = 120_000;

interface Runtime {
	readonly name: string;
	readonly command: () => string[];
}

const RUNTIMES: readonly Runtime[] = [
	{ name: "Node", command: () => [process.execPath, "--import", "jiti/register"] },
	{ name: "Bun", command: () => [bunExecutable()] },
];

const CALLS = [
	{ call: "task", label: "ctx.task", reason: /prompt adapter failed/, rejections: 1 },
	{ call: "stage-prompt", label: "ctx.stage().prompt", reason: /prompt adapter failed/, rejections: 1 },
	{
		call: "stage-methods",
		label: "ctx.stage() steer, followUp, sendUserMessage, setModel, setThinkingLevel, cycleModel, cycleThinkingLevel, navigateTree and compact",
		reason: /prompt adapter not configured/,
		rejections: 9,
	},
	{ call: "chain", label: "ctx.chain", reason: /prompt adapter failed/, rejections: 1 },
	{ call: "parallel", label: "ctx.parallel", reason: /prompt adapter failed/, rejections: 1 },
	{ call: "workflow", label: "ctx.workflow", reason: /child workflow body failed/, rejections: 1 },
	{ call: "ui", label: "ctx.ui.confirm", reason: /ui failed outside the workflow module/, rejections: 1 },
] as const;

interface Report {
	readonly status: string;
	readonly error?: string;
	readonly caught: readonly string[];
	readonly inspected: { readonly kind: string; readonly status?: string };
	readonly healthy?: { readonly status: string; readonly error?: string };
}

function runFixture(runtime: Runtime, args: readonly string[]): { readonly report: Report; readonly stderr: string } {
	const result = spawnSyncCollect([...runtime.command(), FIXTURE, ...args], {
		cwd: ROOT,
		timeout: REAL_CHILD_TIMEOUT_MS,
	});
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	assert.equal(result.exitCode, 0, `${stdout}\n${stderr}`);
	return { report: JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Report, stderr };
}

for (const runtime of RUNTIMES) {
	describe(`dropped ctx promise containment on ${runtime.name}`, () => {
		for (const { call, label, reason, rejections } of CALLS) {
			test(
				`a ${label} rejection the author never handles fails its run instead of completing it (#3846)`,
				() => {
					const { report } = runFixture(runtime, ["dropped", call]);
					assert.equal(report.status, "failed");
					assert.match(report.error ?? "", reason);
					assert.deepEqual(report.inspected, { kind: "found", status: "failed" });
				},
				REAL_CHILD_TIMEOUT_MS,
			);

			test(
				`a ${label} rejection the author handles reaches its catch and leaves the run completed (#3846)`,
				() => {
					const { report } = runFixture(runtime, ["handled", call]);
					assert.equal(report.status, "completed");
					assert.equal(report.caught.length, rejections);
					assert.match(report.caught[0] ?? "", reason);
					assert.deepEqual(report.inspected, { kind: "found", status: "completed" });
				},
				REAL_CHILD_TIMEOUT_MS,
			);
		}

		test(
			"a dropped ctx.task rejection leaves a concurrent run in another module untouched (#3846)",
			() => {
				const { report } = runFixture(runtime, ["dropped", "task", "healthy"]);
				assert.equal(report.status, "failed");
				assert.deepEqual(report.healthy, { status: "completed" });
			},
			REAL_CHILD_TIMEOUT_MS,
		);
	});
}
