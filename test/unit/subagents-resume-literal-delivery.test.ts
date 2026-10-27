/**
 * #4027: a resumed subagent child receives its resume and held messages as written, through the real in-process
 * runner and a real AgentSession against a local provider. Only an original task keeps a fresh launch's handling.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	type Message,
} from "@bastani/pi-ai/compat";
import { afterEach, test } from "vitest";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { AuthStorage, ModelRuntime } from "../../packages/coding-agent/src/index.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";

/** Structural cost: each case builds a real parent and a real child AgentSession with their resource loaders. */
const REAL_CHILD_SESSION_TIMEOUT_MS = 90_000;
const TEMPLATE_PREFIX = "Review this code:";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function usage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userTexts(messages: readonly Message[]): string[] {
	return messages.flatMap((message) => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		return [message.content.map((block) => (block.type === "text" ? block.text : "")).join("")];
	});
}

/** A parent whose agent directory has a `/review` prompt template and a `/workflow` command that leaves a marker. */
async function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-resume-literal-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const agentDir = join(cwd, "agent");
	const marker = join(cwd, "workflow-command-ran");
	mkdirSync(join(agentDir, "prompts"), { recursive: true });
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(join(agentDir, "prompts", "review.md"), `${TEMPLATE_PREFIX} $@`);
	writeFileSync(
		join(agentDir, "extensions", "workflow-command.ts"),
		`import { writeFileSync } from "node:fs";
export default function (pi) {
	pi.registerCommand("workflow", {
		description: "fixture workflow command",
		handler: async () => {
			writeFileSync(${JSON.stringify(marker)}, "ran");
		},
	});
}
`,
	);
	const model = { ...getModel("anthropic", "claude-sonnet-4-5")!, provider: "resume-literal" };
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const requests: Message[][] = [];
	runtime.registerProvider(model.provider, {
		api: model.api,
		baseUrl: model.baseUrl,
		apiKey: "fixture-key",
		models: [model],
		streamSimple: (requestModel, context) => {
			requests.push([...context.messages]);
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: model.api,
				provider: model.provider,
				model: requestModel.id,
				usage: usage(),
				stopReason: "stop",
				timestamp: Date.now(),
			};
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		},
	});
	cleanups.push(() => runtime.unregisterProvider(model.provider));
	const { session: parent } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime: runtime,
		model,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		sessionManager: SessionManager.inMemory(cwd),
		builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: ["read"],
	});
	cleanups.push(() => {
		parent.dispose();
		clearSubagentControls();
	});
	const worker: AgentConfig = {
		name: "worker",
		description: "resume fixture",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: join(cwd, "worker.md"),
		tools: ["read"],
	};
	let runs = 0;
	const run = (task: string, options: { resumeFollowUps?: readonly string[]; resumeTaskLiteral?: boolean }) =>
		runSingleInProcess(cwd, worker, task, {
			cwd,
			runId: `resume-literal-${runs}`,
			index: runs++,
			sessionDir: join(cwd, "children"),
			testSession: false,
			currentModel: `${model.provider}/${model.id}`,
			resolveCandidateModel: () => ({ model }),
			getChildSessionOptions: parent.extensionRunner.createContext().getChildSessionOptions,
			...options,
		});
	return { requests, run, commandRan: () => existsSync(marker) };
}

test(
	"a resumed child gets its resume message and held messages as written, never expanded or run (#4027)",
	async () => {
		const f = await fixture();
		const result = await f.run("/review src/resume.ts", {
			resumeTaskLiteral: true,
			resumeFollowUps: ["/workflow attach run-1", "/review src/held.ts"],
		});

		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.equal(f.commandRan(), false, "a held `/workflow …` message is not run as a command");
		const delivered = userTexts(f.requests.at(-1) ?? []);
		assert.deepEqual(delivered, ["/review src/resume.ts", "/workflow attach run-1", "/review src/held.ts"]);
		assert.ok(
			f.requests.every((request) => userTexts(request).every((text) => !text.startsWith(TEMPLATE_PREFIX))),
			"no resume or held text is expanded as a prompt template",
		);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a resumed child without held messages gets its resume message as written too (#4027)",
	async () => {
		const f = await fixture();
		const result = await f.run("/workflow attach run-2", { resumeTaskLiteral: true });

		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.equal(f.commandRan(), false, "the resume message is not run as a command");
		assert.deepEqual(userTexts(f.requests.at(-1) ?? []), ["/workflow attach run-2"]);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"an original task keeps a fresh launch's handling: its prompt template is expanded (#4027)",
	async () => {
		const f = await fixture();
		const result = await f.run("/review src/task.ts", { resumeFollowUps: ["/review src/held.ts"] });

		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.deepEqual(userTexts(f.requests.at(-1) ?? []), [`${TEMPLATE_PREFIX} src/task.ts`, "/review src/held.ts"]);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);
