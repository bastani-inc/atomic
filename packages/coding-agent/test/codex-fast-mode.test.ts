import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	CODEX_FAST_MODE_SERVICE_TIER,
	getCodexFastModeScope,
	hasSupportedCodexFastModeModel,
	isCodexFastModeEnabledForSession,
	isCodexFastModeSupportedProvider,
	withCodexFastModePayload,
	withCodexFastModeStreamOptions,
} from "../src/core/codex-fast-mode.ts";
import type { OrchestrationContext } from "../src/core/extensions/index.ts";

function model(provider: string): Pick<Model<Api>, "provider"> {
	return { provider };
}

const workflowContext: OrchestrationContext = {
	kind: "workflow-stage",
	workflowRunId: "run-1",
	workflowStageId: "stage-1",
	workflowStageName: "Stage 1",
	constraints: {
		disableWorkflowTool: true,
		maxSubagentDepth: 0,
	},
};

describe("codex fast mode helpers", () => {
	it("supports only OpenAI and OpenAI Codex providers", () => {
		expect(isCodexFastModeSupportedProvider("openai")).toBe(true);
		expect(isCodexFastModeSupportedProvider("openai-codex")).toBe(true);
		expect(isCodexFastModeSupportedProvider("github-copilot")).toBe(false);
		expect(isCodexFastModeSupportedProvider("azure-openai-responses")).toBe(false);
	});

	it("detects supported models from provider IDs", () => {
		expect(hasSupportedCodexFastModeModel([model("github-copilot")])).toBe(false);
		expect(hasSupportedCodexFastModeModel([model("github-copilot"), model("openai")])).toBe(true);
		expect(hasSupportedCodexFastModeModel([model("openai-codex")])).toBe(true);
	});

	it("selects chat versus workflow scope from orchestration context", () => {
		expect(getCodexFastModeScope(undefined)).toBe("chat");
		expect(getCodexFastModeScope(workflowContext)).toBe("workflow");
		expect(isCodexFastModeEnabledForSession({ chat: true, workflow: false }, undefined)).toBe(true);
		expect(isCodexFastModeEnabledForSession({ chat: true, workflow: false }, workflowContext)).toBe(false);
		expect(isCodexFastModeEnabledForSession({ chat: false, workflow: true }, workflowContext)).toBe(true);
	});

	it("adds serviceTier to stream options only when enabled", () => {
		expect(withCodexFastModeStreamOptions(undefined, false)).toBeUndefined();
		expect(withCodexFastModeStreamOptions({ temperature: 0.2 }, false)).toEqual({ temperature: 0.2 });
		expect(withCodexFastModeStreamOptions({ temperature: 0.2 }, true)).toEqual({
			temperature: 0.2,
			serviceTier: CODEX_FAST_MODE_SERVICE_TIER,
		});
	});

	it("adds service_tier to object payloads without overwriting existing values", () => {
		expect(withCodexFastModePayload("not-object", true)).toBe("not-object");
		expect(withCodexFastModePayload(["array"], true)).toEqual(["array"]);
		expect(withCodexFastModePayload({ model: "gpt" }, false)).toEqual({ model: "gpt" });
		expect(withCodexFastModePayload({ model: "gpt" }, true)).toEqual({
			model: "gpt",
			service_tier: CODEX_FAST_MODE_SERVICE_TIER,
		});
		expect(withCodexFastModePayload({ service_tier: "default" }, true)).toEqual({ service_tier: "default" });
	});
});
