import { type Api, clampThinkingLevel, type Model } from "@bastani/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import {
	resolveSessionThinkingDefault,
	resolveThinkingSelectorDefault,
} from "../src/modes/interactive/interactive-model-routing.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

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
		rawDefault,
	);
	const clamped = new ThinkingSelectorComponent(
		"off",
		available,
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

// Upstream pi #8900 adds these as a standalone `test/thinking-selector.test.ts`; Atomic already
// owns a thinking-selector rendering suite, so the case is folded in here rather than duplicating
// the fixture file.
test("keeps the current thinking level marked while browsing", () => {
	setKeybindings(new KeybindingsManager());
	const selector = new ThinkingSelectorComponent(
		"medium",
		["medium", "high"],
		() => {},
		() => {},
	);
	const getLevelRow = (level: string): string | undefined =>
		renderedLines(selector)
			.map((line) => stripAnsi(line))
			.find((line) => line.includes(level));

	expect(selector.getSelectList().getSelectedItem()?.label).toBe("✓ medium");
	expect(getLevelRow("medium")?.startsWith("→ ✓ medium")).toBe(true);
	selector.handleInput("\x1b[B");
	expect(getLevelRow("medium")?.startsWith("  ✓ medium")).toBe(true);
	expect(getLevelRow("high")?.startsWith("→   high")).toBe(true);
});

test("has no save-default shortcut or hint", () => {
	setKeybindings(new KeybindingsManager());
	const select = vi.fn();
	const selector = new ThinkingSelectorComponent("medium", ["medium", "high"], select, () => {});
	expect(stripAnsi(selector.render(120).join("\n"))).not.toContain("set as default");
	selector.handleInput("\x13");
	expect(select).not.toHaveBeenCalled();
	selector.handleInput("\r");
	expect(select).toHaveBeenCalledWith("medium");
});
