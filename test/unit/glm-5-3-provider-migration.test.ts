import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getSupportedThinkingLevels } from "@bastani/pi-ai/compat";
import { getBuiltinModels } from "@bastani/pi-ai/providers/all";
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

const EXPECTED_GLM_FALLBACKS = [
	"zai/glm-5.3:high",
	"zai-coding-cn/glm-5.3:high",
	"zai/glm-5.3-flash:high",
	"zai-coding-cn/glm-5.3-flash:high",
	"baseten/zai-org/GLM-5.3:high",
	"baseten/zai-org/GLM-5.3-Flash:high",
	"openrouter/z-ai/glm-5.3:high",
	"openrouter/z-ai/glm-5.3-flash:high",
] as const;

type GlmProvider = "zai" | "zai-coding-cn" | "baseten" | "openrouter";

function extractGlmReferences(text: string): string[] {
	return text.match(/(?:(?:zai|zai-coding-cn)\/glm|openrouter\/z-ai\/glm|baseten\/zai-org\/GLM)-[^"\s,]+/gu) ?? [];
}

function workflowGlmChains(): Array<{ name: string; references: string[] }> {
	const chains = workflowConfigs.map(([name, config]) => ({
		name,
		references: config.fallbackModels.filter((reference) => extractGlmReferences(reference).length > 0),
	}));
	return [
		...chains,
		{
			name: "Open Claude Design",
			references: extractGlmReferences(read("packages/workflows/builtin/open-claude-design-runner.ts")),
		},
	];
}

function workflowModelReferences(): string[] {
	return workflowGlmChains().flatMap(({ references }) => references);
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

test("builtin workflow GLM fallback chains include every provider mirror in order", () => {
	for (const { name, references } of workflowGlmChains()) {
		assert.deepEqual(references, EXPECTED_GLM_FALLBACKS, name);
	}
});

test("workflow GLM references use catalog-supported thinking levels", () => {
	const references = [...new Set(workflowModelReferences())];
	assert.deepEqual(references, EXPECTED_GLM_FALLBACKS);

	for (const reference of references) {
		const match = /^(zai|zai-coding-cn|baseten|openrouter)\/(.+):([^:]+)$/u.exec(reference);
		assert.ok(match, `GLM workflow reference must include a thinking suffix: ${reference}`);
		if (!match) continue;

		const provider = match[1] as GlmProvider;
		const modelId = match[2];
		const thinkingLevel = match[3];
		assert.ok(modelId);
		assert.ok(thinkingLevel);
		const model = getBuiltinModels(provider).find((candidate) => candidate.id === modelId);
		assert.ok(model, `GLM workflow reference must resolve in the ${provider} catalog: ${reference}`);
		if (!model) continue;

		assert.ok(
			getSupportedThinkingLevels(model).map(String).includes(thinkingLevel),
			`${reference} uses a thinking level unsupported by the ${provider}/${modelId} catalog entry`,
		);
	}
});

test("builtin subagent fallback chains include every GLM-5.3 provider mirror in order", () => {
	const agents = subagentFrontmatter();
	assert.ok(agents.length > 0, "expected builtin subagent definitions");
	for (const { name, text } of agents) {
		assert.doesNotMatch(text, /glm-5\.2/iu, name);
		assert.deepEqual(extractGlmReferences(text), EXPECTED_GLM_FALLBACKS, name);
	}
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
	assert.deepEqual(model.thinkingLevelMap, {
		off: null,
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	});
	assert.equal(
		model.compat && "supportsReasoningEffort" in model.compat ? model.compat.supportsReasoningEffort : undefined,
		true,
	);
	assert.ok(getSupportedThinkingLevels(model).includes("high"));

	const resolved = resolveCliModel({ cliModel: "zai/glm-5.3:high", modelRuntime: runtime });
	assert.equal(resolved.error, undefined);
	assert.equal(resolved.model?.id, "glm-5.3");
	const codingCnModel = runtime.getModel("zai-coding-cn", "glm-5.3");
	assert.ok(codingCnModel);
	assert.equal(codingCnModel.id, "glm-5.3");
	assert.deepEqual(codingCnModel.thinkingLevelMap, {
		off: null,
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	});
	assert.equal(
		codingCnModel.compat && "supportsReasoningEffort" in codingCnModel.compat
			? codingCnModel.compat.supportsReasoningEffort
			: undefined,
		true,
	);
	assert.ok(getSupportedThinkingLevels(codingCnModel).includes("high"));
	assert.equal(resolved.thinkingLevel, "high");
	assert.equal(runtime.getModel("zai-coding-cn", "glm-5.3")?.id, "glm-5.3");
});

test("every GLM provider catalog exposes full and Flash GLM-5.3 entries", () => {
	const variants = [
		["zai", "glm-5.3"],
		["zai", "glm-5.3-flash"],
		["zai-coding-cn", "glm-5.3"],
		["zai-coding-cn", "glm-5.3-flash"],
		["openrouter", "z-ai/glm-5.3"],
		["openrouter", "z-ai/glm-5.3-flash"],
		["baseten", "zai-org/GLM-5.3"],
		["baseten", "zai-org/GLM-5.3-Flash"],
	] as const;

	for (const [provider, modelId] of variants) {
		const model = getBuiltinModels(provider).find((candidate) => candidate.id === modelId);
		assert.ok(model, `${provider}/${modelId} must exist in the generated catalog`);
		assert.ok(getSupportedThinkingLevels(model).includes("high"));
	}
});

test("Baseten defaults to its directly selectable full GLM-5.3 entry", () => {
	const basetenModels = getBuiltinModels("baseten");
	assert.equal(defaultModelPerProvider.baseten, "zai-org/GLM-5.3");
	assert.notEqual(defaultModelPerProvider.baseten, "zai-org/GLM-5.3-Flash");
	assert.ok(basetenModels.some((model) => model.id === defaultModelPerProvider.baseten));
	assert.match(
		read("packages/coding-agent/docs/providers.md"),
		/Baseten defaults to its directly selectable `zai-org\/GLM-5\.3`/iu,
	);
});
