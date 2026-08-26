import { type Api, clampThinkingLevel, type Model } from "@bastani/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { beforeAll, expect, test } from "vitest";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import {
	resolveSessionThinkingDefault,
	resolveThinkingSelectorDefault,
} from "../src/modes/interactive/interactive-model-routing.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

function nonReasoningModel(): Model<Api> {
	return {
		id: "tiny",
		name: "tiny",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1024,
		maxTokens: 256,
	} as Model<Api>;
}

function renderedLines(selector: ThinkingSelectorComponent): string[] {
	return selector.getSelectList().render(80);
}

test("keeps a saved default that the active model supports", () => {
	expect(resolveThinkingSelectorDefault("high", ["off", "low", "medium", "high"], undefined)).toBe("high");
});

test("clamps an unsupported global default to the startup-effective level", () => {
	const model = nonReasoningModel();
	expect(clampThinkingLevel(model, "high")).toBe("off");
	expect(resolveThinkingSelectorDefault("high", ["off"], model)).toBe("off");
});

test("clamps an unsupported per-model default the same way", () => {
	const model = nonReasoningModel();
	expect(resolveThinkingSelectorDefault("high" as ThinkingLevel, ["off"], model)).toBe("off");
});

test("leaves the badge unset when no saved default exists", () => {
	expect(resolveThinkingSelectorDefault(undefined, ["off"], nonReasoningModel())).toBeUndefined();
});

test("selector badges the clamped default rather than leaving no item marked", () => {
	const rawDefault: ThinkingLevel = "high";
	const available: ThinkingLevel[] = ["off"];
	const model = nonReasoningModel();
	const unclamped = new ThinkingSelectorComponent(
		"off",
		available,
		() => {},
		() => {},
		() => {},
		rawDefault,
	);
	const clamped = new ThinkingSelectorComponent(
		"off",
		available,
		() => {},
		() => {},
		() => {},
		resolveThinkingSelectorDefault(rawDefault, available, model),
	);

	expect(renderedLines(unclamped).some((line) => line.includes("default"))).toBe(false);
	expect(renderedLines(clamped).some((line) => line.includes("default"))).toBe(true);
});

function reasoningModel(id = "big"): Model<Api> {
	return { ...nonReasoningModel(), id, name: id, reasoning: true } as Model<Api>;
}

const savedLevels = (perModel?: ThinkingLevel, global?: ThinkingLevel) => ({
	getModelThinkingLevel: () => perModel,
	getDefaultThinkingLevel: () => global,
});

test("a scoped model level outranks the global default", () => {
	const model = reasoningModel();
	// `--models "big:high"` with a global default of low: startup runs at high.
	expect(resolveSessionThinkingDefault(model, [{ model, thinkingLevel: "high" }], savedLevels(undefined, "low"))).toBe(
		"high",
	);
});

test("a scoped model level outranks a persisted per-model override", () => {
	const model = reasoningModel();
	expect(resolveSessionThinkingDefault(model, [{ model, thinkingLevel: "high" }], savedLevels("medium", "low"))).toBe(
		"high",
	);
});

test("a scoped entry for a different model does not leak its level", () => {
	const active = reasoningModel("active");
	const other = reasoningModel("other");
	expect(
		resolveSessionThinkingDefault(active, [{ model: other, thinkingLevel: "high" }], savedLevels(undefined, "low")),
	).toBe("low");
});

test("falls back to the per-model override, then the global default", () => {
	const model = reasoningModel();
	expect(resolveSessionThinkingDefault(model, [], savedLevels("medium", "low"))).toBe("medium");
	expect(resolveSessionThinkingDefault(model, [], savedLevels(undefined, "low"))).toBe("low");
	expect(resolveSessionThinkingDefault(model, [{ model }], savedLevels(undefined, "low"))).toBe("low");
});
