/**
 * End-to-end coverage for the fork-context model defect, executed rather than
 * inferred.
 *
 * `test/unit/subagents-fork-context-model.test.ts` pins the seam that carried
 * the bug — the `ChildSpec`/`ModelCandidate` handed to `startAttempt` — but it
 * stops there, so the final link rested on reading `createAgentSession`:
 * `let model = options.model;` followed by a session-file restore guarded by
 * `if (!model && hasExistingSession …)` (`packages/coding-agent/src/core/sdk.ts`).
 *
 * This suite executes that whole chain against real collaborators: a real
 * `ModelRuntime`/`ModelRegistry` built from a temporary `models.json`, the real
 * candidate resolution inside `runSingleInProcess`, a real session file written
 * by a real `SessionManager` and reopened with `SessionManager.open` the way the
 * fork path does, and the real `createAgentSession`. The assertion is on the
 * created session's active model.
 *
 * No provider is contacted: `createAgentSession` refreshes the model runtime
 * with `allowNetwork: false`, the runtime is created with `allowModelNetwork`
 * unset, both models are declared locally in `models.json`, and no turn is run.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { afterAll, describe, test, vi } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader.ts";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import type { ResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import type { AttemptOutcome, ModelCandidate } from "../../packages/subagents/src/runs/inprocess/runner.ts";
import { createCandidateModelResolver } from "../../packages/subagents/src/shared/model-resolution.ts";

const harness = vi.hoisted(() => ({ attempts: [] as { spec: unknown; candidate: unknown }[] }));

/**
 * The control plane is the natives-backed admission door and is no part of
 * model selection; this double records the attempt inputs and settles. Every
 * other collaborator in this file is real.
 */
vi.mock("../../packages/subagents/src/runs/inprocess/control-registry.ts", () => {
	const outcome = {
		status: "ok" as const,
		output: "done",
		envelope: "done",
		path: "child/0",
		stats: {
			sessionFile: undefined,
			sessionId: "test-session",
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 2,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		},
	};
	const control = {
		registerAgents: () => undefined,
		admitChildSession: (spec: unknown) => ({
			admitted: {
				identity: { path: "child/0", depth: 1 },
				spec,
				policy: { cwd: "" },
				sessionDir: "",
			},
		}),
		startAttempt: (admitted: { spec: unknown }, candidate: unknown) => {
			harness.attempts.push({ spec: admitted.spec, candidate });
			return { status: "running", promise: Promise.resolve(outcome as AttemptOutcome) };
		},
		registerNestedAttempt: () => undefined,
		continueDetached: () => undefined,
		deliverChildResult: async () => undefined,
		getDeliveredResult: () => undefined,
	};
	return { getOrCreateSubagentControl: () => control };
});

const { runSingleInProcess } = await import("../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts");

const PARENT_PROVIDER = "fork-parent-provider";
const PARENT_MODEL_ID = "parent-model";
const CHILD_PROVIDER = "fork-child-provider";
const CHILD_MODEL_ID = "child-model";
const PARENT_FULL_ID = `${PARENT_PROVIDER}/${PARENT_MODEL_ID}`;
const CHILD_FULL_ID = `${CHILD_PROVIDER}/${CHILD_MODEL_ID}`;

const roots: string[] = [];

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A locally declared provider: no catalog fetch and no off-box credential. */
function providerEntry(baseUrl: string, modelId: string): Record<string, unknown> {
	return {
		baseUrl,
		apiKey: "test-key",
		api: "openai-completions",
		models: [
			{
				id: modelId,
				name: modelId,
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 32_000,
			},
		],
	};
}

function resourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => "CHILD_PROMPT",
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: async () => {},
		reload: async () => {},
	};
}

interface ForkFixture {
	readonly cwd: string;
	readonly agentDir: string;
	readonly sessionDir: string;
	/** A real session file carrying the parent's message and `model_change`. */
	readonly parentSessionFile: string;
	readonly modelRuntime: ModelRuntime;
	readonly registry: ModelRegistry;
	readonly childModel: Model<Api>;
	readonly parentModel: Model<Api>;
}

/**
 * Build what a fork-context child starts from: a real session file whose
 * persisted model is the parent's, and a runtime that knows both models.
 */
async function createForkFixture(): Promise<ForkFixture> {
	const root = mkdtempSync(join(tmpdir(), "subagent-fork-session-"));
	roots.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	for (const dir of [cwd, agentDir, sessionDir]) mkdirSync(dir, { recursive: true });

	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[PARENT_PROVIDER]: providerEntry("https://parent.invalid/v1", PARENT_MODEL_ID),
				[CHILD_PROVIDER]: providerEntry("https://child.invalid/v1", CHILD_MODEL_ID),
			},
		}),
	);

	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	await authStorage.modify(PARENT_PROVIDER, async () => ({ type: "api_key", key: "test-key" }));
	await authStorage.modify(CHILD_PROVIDER, async () => ({ type: "api_key", key: "test-key" }));

	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(agentDir, "models.json"),
	});
	const registry = new ModelRegistry(modelRuntime);
	const childModel = registry.find(CHILD_PROVIDER, CHILD_MODEL_ID);
	const parentModel = registry.find(PARENT_PROVIDER, PARENT_MODEL_ID);
	assert.ok(childModel, "the child model must be declared in the temporary models.json");
	assert.ok(parentModel, "the parent model must be declared in the temporary models.json");

	// Write the parent's session with the real writer, so the file carries the
	// exact entries a fork inherits.
	const parent = SessionManager.create(cwd, sessionDir);
	parent.appendMessage({ role: "user", content: "parent turn", timestamp: Date.now() });
	parent.appendModelChange(PARENT_PROVIDER, PARENT_MODEL_ID);
	parent.flush();
	const parentSessionFile = parent.getSessionFile();
	assert.ok(parentSessionFile, "the parent session must be file-backed");

	return { cwd, agentDir, sessionDir, parentSessionFile, modelRuntime, registry, childModel, parentModel };
}

function agentConfig(model: string): AgentConfig {
	return {
		name: "worker",
		description: "worker",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: true,
		systemPrompt: "worker",
		source: "user",
		filePath: "/tmp/worker.md",
		model,
	} as AgentConfig;
}

/** Run the real selection path and return the candidate handed to the attempt. */
async function selectCandidate(fixture: ForkFixture, options: { resolve: boolean }): Promise<ModelCandidate> {
	harness.attempts.length = 0;
	const resolver = options.resolve
		? { resolveCandidateModel: createCandidateModelResolver(fixture.registry, PARENT_PROVIDER) }
		: {};
	await runSingleInProcess(fixture.cwd, agentConfig(CHILD_FULL_ID), "do the thing", {
		cwd: fixture.cwd,
		runId: "run-1",
		testSession: { output: "done" },
		sessionFile: fixture.parentSessionFile,
		availableModels: [
			{ provider: CHILD_PROVIDER, id: CHILD_MODEL_ID, fullId: CHILD_FULL_ID },
			{ provider: PARENT_PROVIDER, id: PARENT_MODEL_ID, fullId: PARENT_FULL_ID },
		],
		knownModelProviders: [CHILD_PROVIDER, PARENT_PROVIDER],
		preferredModelProvider: PARENT_PROVIDER,
		currentModel: PARENT_FULL_ID,
		...resolver,
	});
	assert.equal(harness.attempts.length, 1, "exactly one attempt should start");
	return harness.attempts[0]!.candidate as ModelCandidate;
}

/**
 * Create the child session exactly as `runChildAttempt` does for a fork:
 * `SessionManager.open` on the inherited file, and
 * `model: candidate.model ?? policy.model` — this run carries no policy model.
 */
async function openChildSession(fixture: ForkFixture, candidate: ModelCandidate): Promise<Model<Api> | undefined> {
	const sessionManager = SessionManager.open(fixture.parentSessionFile, fixture.sessionDir, fixture.cwd);
	const { session } = await createAgentSession({
		cwd: fixture.cwd,
		agentDir: fixture.agentDir,
		model: candidate.model,
		thinkingLevel: candidate.thinkingLevel,
		modelRuntime: fixture.modelRuntime,
		settingsManager: SettingsManager.create(fixture.cwd, fixture.agentDir),
		sessionManager,
		resourceLoader: resourceLoader(),
	});
	return session.model;
}

describe("fork-context child session model (executed end to end)", () => {
	test("the resolved candidate model beats the model persisted in the forked session file", async () => {
		const fixture = await createForkFixture();
		const candidate = await selectCandidate(fixture, { resolve: true });
		const sessionModel = await openChildSession(fixture, candidate);

		// The session-level assertion comes first on purpose: it is the claim
		// that matters, and it is what fails on pre-fix source.
		assert.equal(sessionModel?.provider, CHILD_PROVIDER);
		assert.equal(sessionModel?.id, CHILD_MODEL_ID);
		assert.deepEqual(candidate.model, fixture.childModel);
	});
	test("the forked session file really does carry the parent's model", async () => {
		const fixture = await createForkFixture();
		const sessionModel = await openChildSession(fixture, {});

		assert.equal(sessionModel?.provider, PARENT_PROVIDER);
		assert.equal(sessionModel?.id, PARENT_MODEL_ID);
	});

	test("an unresolved candidate lets the parent's model win — the reported bug", async () => {
		const fixture = await createForkFixture();
		const candidate = await selectCandidate(fixture, { resolve: false });

		// The pre-fix state: a candidate string, and no model object to hand on.
		assert.equal(candidate.model, undefined);
		assert.equal(candidate.modelId, CHILD_FULL_ID);

		const sessionModel = await openChildSession(fixture, candidate);
		assert.equal(sessionModel?.provider, PARENT_PROVIDER);
		assert.equal(sessionModel?.id, PARENT_MODEL_ID);
	});
});
