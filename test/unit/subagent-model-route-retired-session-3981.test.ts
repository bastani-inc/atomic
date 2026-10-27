import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import { STALE_EXTENSION_CONTEXT_MESSAGE } from "../../packages/coding-agent/src/core/extensions/stale-context.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { routeSubagentModel } from "../../packages/subagents/src/runs/shared/model-router.js";
import { chatRouter } from "../helpers/model-routing.js";
import { decisionModel, registeredDecisionRuntime } from "../helpers/structured-output.js";

beforeEach(() => vi.stubEnv("TYPESAFE_API_KEY", ""));
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const agent: AgentConfig = {
	name: "worker",
	description: "Implement approved work",
	systemPrompt: "Implement only approved changes",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "user",
	filePath: "",
	model: "auto",
};

/**
 * The tool context of a stage session. Model fallback retires that session while the subagent it launched keeps
 * running; from then on every read of the context throws, exactly as the host's retired runtime does.
 */
async function launchingContext() {
	const { registry } = await registeredDecisionRuntime(chatRouter());
	let retired = false;
	const live = <T>(value: T): T => {
		if (retired) throw new Error(STALE_EXTENSION_CONTEXT_MESSAGE);
		return value;
	};
	const ctx = {
		get model() {
			return live(decisionModel);
		},
		get modelRegistry() {
			return live(registry);
		},
		getRouterModel: () => live("decision-test/chat"),
	} as ExtensionContext;
	return {
		ctx,
		retire: () => {
			retired = true;
		},
	};
}

test("a subagent's model route still answers after model fallback retires the session that launched it (#3981)", async () => {
	const launching = await launchingContext();
	const route = await routeSubagentModel({ ctx: launching.ctx, agent, task: "Fix the approved defect" });
	const candidate = route.modelOverride;
	const before = {
		model: route.allowsModel(decisionModel, route.routerSelection.effort ?? undefined),
		candidate: route.allowsCandidate(candidate, route.routerSelection.effort ?? "off"),
	};
	assert.deepEqual(before, { model: true, candidate: true });

	launching.retire();

	// The child session calls these as its fallback gate and launch check long after the launching session is gone.
	assert.doesNotThrow(() => route.assertCurrent());
	assert.deepEqual(
		{
			model: route.allowsModel(decisionModel, route.routerSelection.effort ?? undefined),
			candidate: route.allowsCandidate(candidate, route.routerSelection.effort ?? "off"),
		},
		before,
	);
});
