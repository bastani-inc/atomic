import assert from "node:assert/strict";
import { test } from "vitest";
import { unwrapSubagentPrompt } from "../../packages/subagents/src/extension/tool-rendering.js";
import { bunExecutable, readStreamText, spawnProcess } from "../helpers/runtime.js";

const PROMPT_UNWRAP_PROCESS_TIMEOUT_MS = 15_000;

const progressLabels = ["Create and maintain progress at:", "Update progress at:", "Write your findings to:"];

test("subagent prompt rendering stays responsive with long malformed progress suffixes (#5239)", async () => {
	const moduleUrl = new URL("../../packages/subagents/src/extension/tool-rendering.ts", import.meta.url).href;
	const child = spawnProcess(
		[
			bunExecutable(),
			"-e",
			`
				import assert from "node:assert/strict";
				const { unwrapSubagentPrompt } = await import(${JSON.stringify(moduleUrl)});
				for (const label of ${JSON.stringify(progressLabels)}) {
					const task = "Inspect the parser.\\n\\n---\\n" + label + " ".repeat(256 * 1024) + "\\nkeep\\nthis";
					assert.equal(unwrapSubagentPrompt(task), task);
				}
				process.stdout.write("ok");
			`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, PROMPT_UNWRAP_PROCESS_TIMEOUT_MS);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			readStreamText(child.stdout),
			readStreamText(child.stderr),
		]);
		assert.equal(timedOut, false, "progress suffix rendering exceeded its process budget");
		assert.equal(exitCode, 0, stderr);
		assert.equal(stdout, "ok");
	} finally {
		clearTimeout(timer);
		child.kill("SIGKILL");
	}
});

test("subagent prompt rendering removes progress suffixes without losing task text (#5239)", () => {
	for (const label of progressLabels) {
		for (const suffix of [" progress.md", "\tprogress.md", "\n \nprogress.md", " "]) {
			assert.equal(unwrapSubagentPrompt(`Inspect the parser.\n\n---\n${label}${suffix}`), "Inspect the parser.");
		}
		for (const suffix of [" progress.md\nKeep this instruction.", " progress.md\n"]) {
			const task = `Inspect the parser.\n\n---\n${label}${suffix}`;
			assert.equal(unwrapSubagentPrompt(task), task.trim());
		}
	}
});
