import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { test } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { resolveCliModel } from "../../packages/coding-agent/src/core/model-resolver.ts";
import { defaultModelPerProvider } from "../../packages/coding-agent/src/core/model-resolver-defaults.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import {
	orchestratorModelConfig as goalOrchestratorModelConfig,
	reviewerModelConfig as goalReviewerModelConfig,
} from "../../packages/workflows/builtin/goal-models.js";
import {
	promptEngineerModelConfig,
	orchestratorModelConfig as ralphOrchestratorModelConfig,
	researchModelConfig,
	reviewerAModelConfig,
	reviewerBModelConfig,
} from "../../packages/workflows/builtin/ralph-models.js";
import { moduleDir } from "../helpers/runtime.js";

const root = resolve(moduleDir(import.meta.url), "../..");
const read = (relativePath: string): string => readFileSync(join(root, relativePath), "utf8");

const workflowConfigs = [
	["Goal orchestrator", goalOrchestratorModelConfig],
	["Goal reviewer", goalReviewerModelConfig],
	["Ralph prompt engineer", promptEngineerModelConfig],
	["Ralph research", researchModelConfig],
	["Ralph orchestrator", ralphOrchestratorModelConfig],
	["Ralph reviewer A", reviewerAModelConfig],
	["Ralph reviewer B", reviewerBModelConfig],
] as const;

function workflowModelReferences(): string[] {
	const references = workflowConfigs.flatMap(([, config]) => [config.model, ...(config.fallbackModels ?? [])]);
	const openClaudeSource = read("packages/workflows/builtin/open-claude-design-runner.ts");
	return [...references, ...(openClaudeSource.match(/(?:zai|zai-coding-cn|openrouter\/z-ai)\/glm-[^"\s,]+/gu) ?? [])];
}

function subagentFrontmatter(): Array<{ name: string; text: string }> {
	const agentsDir = join(root, "packages/subagents/agents");
	return readdirSync(agentsDir)
		.filter((name) => name.endsWith(".md"))
		.map((name) => ({ name, text: readFileSync(join(agentsDir, name), "utf8").split("---", 2)[1] ?? "" }));
}
function recursivelyListFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? recursivelyListFiles(path) : [path];
	});
}

function builtinSourceFiles(): string[] {
	return ["packages/workflows/builtin", "packages/subagents/agents"].flatMap((relativePath) =>
		recursivelyListFiles(join(root, relativePath)),
	);
}

test("builtin workflow and subagent sources contain no stale GLM-5.2 references", () => {
	for (const filePath of builtinSourceFiles()) {
		assert.doesNotMatch(readFileSync(filePath, "utf8"), /glm[- /]?5\.2/i, filePath);
	}
});

test("builtin Goal, Ralph, and Open Claude Design chains have no active GLM-5.2 entries", () => {
	for (const reference of workflowModelReferences()) {
		assert.doesNotMatch(reference, /glm-5\.2/iu, reference);
	}
});

test("workflow direct Z.AI GLM references use catalog-supported thinking levels", () => {
	const directReferences = workflowModelReferences().filter((reference) =>
		/^(?:zai|zai-coding-cn)\/glm-/u.test(reference),
	);
	assert.ok(directReferences.length > 0, "expected direct Z.AI GLM workflow references");

	for (const reference of directReferences) {
		const match = /^(zai|zai-coding-cn)\/(glm-[^:]+):([^:]+)$/u.exec(reference);
		assert.ok(match, `direct GLM workflow reference must include a thinking suffix: ${reference}`);
		if (!match) continue;

		const [, provider, modelId, thinkingLevel] = match;
		assert.ok(provider === "zai" || provider === "zai-coding-cn", `unexpected direct GLM provider: ${provider}`);
		if (provider !== "zai" && provider !== "zai-coding-cn") continue;
		const model = getBuiltinModels(provider).find((candidate) => candidate.id === modelId);
		assert.ok(model, `direct GLM workflow reference must resolve in the ${provider} catalog: ${reference}`);
		if (!model) continue;

		assert.ok(
			getSupportedThinkingLevels(model).map(String).includes(thinkingLevel),
			`${reference} uses a thinking level unsupported by the ${provider}/${modelId} catalog entry`,
		);
	}
});

test("builtin subagent fallback chains use GLM-5.3 and omit OpenRouter GLM fallbacks", () => {
	const allDirectGlmReferences: string[] = [];
	for (const { name, text } of subagentFrontmatter()) {
		assert.doesNotMatch(text, /glm-5\.2/iu, name);
		assert.doesNotMatch(text, /openrouter\/z-ai\/glm-5\.3/iu, name);
		const directGlmReferences = text.match(/(?:zai|zai-coding-cn)\/glm-[^,\s]+/gu) ?? [];
		for (const reference of directGlmReferences) {
			const expectedReference = reference.startsWith("zai-coding-cn/")
				? "zai-coding-cn/glm-5.3:high"
				: "zai/glm-5.3:high";
			assert.equal(reference, expectedReference, name);
			allDirectGlmReferences.push(reference);
		}
	}
	assert.ok(
		allDirectGlmReferences.length > 0,
		"expected at least one direct Z.AI GLM fallback across builtin subagents",
	);
});

test("direct Z.AI GLM-5.3 resolves through ModelRuntime with the catalog-supported high suffix", async () => {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const model = runtime.getModel("zai", "glm-5.3");
	assert.ok(model);
	assert.equal(model.id, "glm-5.3");
	assert.equal(model.provider, "zai");
	assert.equal(model.thinkingLevelMap, undefined);
	assert.equal(
		model.compat && "supportsReasoningEffort" in model.compat ? model.compat.supportsReasoningEffort : undefined,
		false,
	);
	assert.ok(getSupportedThinkingLevels(model).includes("high"));

	const resolved = resolveCliModel({ cliModel: "zai/glm-5.3:high", modelRuntime: runtime });
	assert.equal(resolved.error, undefined);
	assert.equal(resolved.model?.id, "glm-5.3");
	const codingCnModel = runtime.getModel("zai-coding-cn", "glm-5.3");
	assert.ok(codingCnModel);
	assert.equal(codingCnModel.id, "glm-5.3");
	assert.equal(codingCnModel.thinkingLevelMap, undefined);
	assert.equal(
		codingCnModel.compat && "supportsReasoningEffort" in codingCnModel.compat
			? codingCnModel.compat.supportsReasoningEffort
			: undefined,
		false,
	);
	assert.ok(getSupportedThinkingLevels(codingCnModel).includes("high"));
	assert.equal(resolved.thinkingLevel, "high");
	assert.equal(runtime.getModel("zai-coding-cn", "glm-5.3")?.id, "glm-5.3");
});

test("OpenRouter GLM-5.3 remains absent and no built-in chain ships an unavailable placeholder", () => {
	const openrouterModels = getBuiltinModels("openrouter");
	assert.equal(
		openrouterModels.some((model) => model.id === "z-ai/glm-5.3"),
		false,
	);
	assert.equal(
		openrouterModels.some((model) => model.id === "z-ai/glm-5.2"),
		true,
	);
	assert.equal(
		workflowModelReferences().some((reference) => /openrouter\/z-ai\/glm-5\.3/iu.test(reference)),
		false,
	);
	for (const { name, text } of subagentFrontmatter()) {
		assert.doesNotMatch(text, /openrouter\/z-ai\/glm-5\.3/iu, name);
	}
});

test("Baseten retains its GLM-5.2 default as the documented provider exception", () => {
	const basetenModels = getBuiltinModels("baseten");
	assert.equal(defaultModelPerProvider.baseten, "zai-org/GLM-5.2");
	assert.equal(
		basetenModels.some((model) => model.id === "zai-org/GLM-5.3"),
		false,
	);
	assert.ok(basetenModels.some((model) => model.id === "zai-org/GLM-5.2"));
	assert.match(read("packages/coding-agent/docs/providers.md"), /Baseten[^\n]*no GLM-5\.3/iu);
});
