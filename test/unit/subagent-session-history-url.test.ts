/**
 * A subagent whose session has no file of its own is named by its history URL, and the session that launched it can
 * read that URL as written. The URL reads the session in the project its session records, which for a forked child
 * is its parent's, whatever directory the child ran in. Real in-process runner and real parent and child sessions in
 * a SQLite store, against a local model.
 */

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { createHistoryRouter } from "../../packages/coding-agent/src/core/tools/history-protocol.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** Structural cost: each case builds a real parent AgentSession and a real child AgentSession with its resources. */
const REAL_CHILD_SESSION_TIMEOUT_MS = 90_000;
const ANSWER = "answered from elsewhere 41c9";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	clearSubagentControls();
});

function helper(cwd: string): AgentConfig {
	return {
		name: "helper",
		description: "answers",
		systemPrompt: "Answer.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: join(cwd, "helper.md"),
		tools: ["read"],
	};
}

/** A parent session in `project`, kept in a SQLite store, and a directory of another project a child can run in. */
async function parentWithElsewhere() {
	const root = makeTempDirectory("atomic-child-history-url-");
	cleanups.push(() => removeTempDirectory(root));
	const project = join(root, "project-a");
	const elsewhere = join(root, "project-b");
	mkdirSync(project);
	mkdirSync(elsewhere);
	const faux = registerFauxProvider();
	cleanups.push(() => faux.unregister());
	const model = faux.getModel();
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [{ ...model }] });
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const { session: parent } = await createAgentSession({
		cwd: project,
		agentDir,
		modelRuntime,
		model,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		builtins: { subagents: false, mcp: false, "web-access": false, intercom: false },
		tools: ["read"],
		sessionStore: { kind: "sqlite", path: join(root, "sessions.sqlite") },
	});
	cleanups.push(() => parent.dispose());
	await parent.sessionManager.appendMessage({ role: "user", content: "delegate", timestamp: Date.now() });
	return { faux, model, parent, project, elsewhere };
}

/** Runs one child in `elsewhere`, and reads the history URL its result names as the parent's `read` would. */
async function runElsewhere(fixture: Awaited<ReturnType<typeof parentWithElsewhere>>, fork: boolean) {
	const { faux, model, parent, project, elsewhere } = fixture;
	faux.setResponses([fauxAssistantMessage(ANSWER)]);
	const store = parent.sessionManager.getSessionStore();
	const forked = fork
		? await createForkContextResolver(parent.sessionManager, "fork").sessionManagerForIndex(0)
		: undefined;
	const fullId = `${model.provider}/${model.id}`;
	let cleanup: Promise<unknown> | undefined;
	const result = await runSingleInProcess(project, helper(elsewhere), "Answer from there.", {
		cwd: elsewhere,
		runId: fork ? "fork-elsewhere" : "fresh-elsewhere",
		index: 0,
		testSession: false,
		modelOverride: fullId,
		knownModelProviders: [model.provider],
		currentModel: fullId,
		availableModels: [{ provider: model.provider, id: model.id, fullId }],
		getChildSessionOptions: parent.extensionRunner.createContext().getChildSessionOptions,
		...(forked ? { sessionManager: forked } : { sessionStore: store }),
		taskExecution: {
			signal: new AbortController().signal,
			reportActivity() {},
			onExecution(execution) {
				cleanup = execution.cleanup;
			},
		},
	});
	await cleanup;
	assert.equal(result.status, "ok", result.error);
	assert.equal(result.sessionFile, undefined, "the child's session is in its parent's store");
	assert.ok(result.sessionUrl, "the result names the child's session");
	const router = createHistoryRouter({
		cwd: project,
		currentSessionId: parent.sessionManager.getSessionId(),
		sessionStore: () => store,
	});
	const text = String(await router.read?.(result.sessionUrl));
	return { url: result.sessionUrl, text };
}

test(
	"a fresh subagent that ran in another project is named by a history URL its parent reads as written",
	async () => {
		const fixture = await parentWithElsewhere();
		const { url, text } = await runElsewhere(fixture, false);
		assert.match(url, /\?project=/, "the URL names the project the child's session records");
		assert.ok(text.includes(ANSWER), `${url} reads the child's answer:\n${text.slice(0, 400)}`);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a forked subagent that ran in another directory is named by a history URL in its parent's project, which its parent reads",
	async () => {
		const fixture = await parentWithElsewhere();
		const { url, text } = await runElsewhere(fixture, true);
		assert.doesNotMatch(url, /\?project=/, "a fork's session records its parent's project");
		assert.ok(text.includes(ANSWER), `${url} reads the child's answer:\n${text.slice(0, 400)}`);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);
