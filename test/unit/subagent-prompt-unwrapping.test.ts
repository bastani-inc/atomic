import assert from "node:assert/strict";
import { test } from "vitest";
import { unwrapSubagentPrompt } from "../../packages/subagents/src/extension/tool-rendering.js";
import { bunExecutable, readStreamText, spawnProcess } from "../helpers/runtime.js";

const PROMPT_UNWRAP_PROCESS_TIMEOUT_MS = 15_000;

const progressLabels = ["Create and maintain progress at:", "Update progress at:", "Write your findings to:"];
const renderingModuleUrl = new URL("../../packages/subagents/src/extension/tool-rendering.ts", import.meta.url).href;

async function assertResponsivePromptRendering(script: string): Promise<void> {
	const child = spawnProcess(
		[bunExecutable(), "-e", `import assert from "node:assert/strict"; ${script}; process.stdout.write("ok");`],
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
		assert.equal(timedOut, false, "prompt wrapper rendering exceeded its process budget");
		assert.equal(exitCode, 0, stderr);
		assert.equal(stdout, "ok");
	} finally {
		clearTimeout(timer);
		child.kill("SIGKILL");
	}
}

test("subagent prompt rendering stays responsive with long malformed progress suffixes (#5239)", async () => {
	await assertResponsivePromptRendering(`
		const { unwrapSubagentPrompt } = await import(${JSON.stringify(renderingModuleUrl)});
		for (const label of ${JSON.stringify(progressLabels)}) {
			const task = "Inspect the parser.\\n\\n---\\n" + label + " ".repeat(256 * 1024) + "\\nkeep\\nthis";
			assert.equal(unwrapSubagentPrompt(task), task);
		}
	`);
});

test("subagent prompt rendering stays responsive with long malformed output wrappers (#5239)", async () => {
	await assertResponsivePromptRendering(`
		const { unwrapSubagentPrompt } = await import(${JSON.stringify(renderingModuleUrl)});
		const task = "Inspect the parser.\\n\\n[Write to:" + " ".repeat(1024 * 1024) + "\\nkeep\\nthis";
		assert.equal(unwrapSubagentPrompt(task), task);
	`);
});

test.each(["progress", "output"])(
	"hydrated subagent prompts stay responsive with long malformed %s wrappers (#5239)",
	async (wrapper) => {
		const cardModuleUrl = new URL(
			"../../packages/subagents/src/runs/foreground/subagent-child-card-state.ts",
			import.meta.url,
		).href;
		const sessionModuleUrl = new URL("../../packages/coding-agent/src/core/session-manager.ts", import.meta.url).href;
		const storeModuleUrl = new URL(
			"../../packages/coding-agent/src/core/storage/session/memory-session-store.ts",
			import.meta.url,
		).href;
		await assertResponsivePromptRendering(`
			const { SessionManager } = await import(${JSON.stringify(sessionModuleUrl)});
			const { MemorySessionStore } = await import(${JSON.stringify(storeModuleUrl)});
			const { bindSubagentChildCards, subagentChildTranscriptDetails } = await import(${JSON.stringify(cardModuleUrl)});
			const store = new MemorySessionStore();
			const owner = await SessionManager.create(store, process.cwd());
			const child = await SessionManager.create(store, process.cwd());
			const prefix = ${JSON.stringify(wrapper === "progress" ? "\n\n---\nUpdate progress at:" : "\n\n[Write to:")};
			const task = "Inspect the parser." + prefix + " ".repeat(256 * 1024) + "\\nkeep\\nthis";
			await child.appendMessage({ role: "user", content: task, timestamp: 1 });
			bindSubagentChildCards({ sessionManager: owner });
			const card = {};
			const record = {
				childId: "prompt-case", runId: "prompt-run", index: 0, agent: "worker",
				ownerSessionId: owner.getSessionId(), childSessionId: child.getSessionId(),
				cwd: process.cwd(), state: "terminal", terminalStatus: "completed",
			};
			let prompt;
			while (prompt === undefined) {
				prompt = subagentChildTranscriptDetails(card, record)?.prompt;
				if (prompt === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.equal(prompt, task);
		`);
	},
);

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

test("subagent prompt rendering removes output wrappers without losing task text (#5239)", () => {
	for (const suffix of [" report.md]", "\treport.md]", "\n \nreport.md]", " ]", " report.md]\n "]) {
		assert.equal(unwrapSubagentPrompt(`Inspect the parser.\n\n[Write to:${suffix}`), "Inspect the parser.");
	}
	const task = "Inspect the parser.\n\n[Write to: report.md]\nKeep this instruction.";
	assert.equal(unwrapSubagentPrompt(task), task);
});
