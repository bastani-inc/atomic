import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import {
	formatContextWindow,
	getSupportedContextWindows,
	parseContextWindowValue,
	selectContextWindow,
	withContextWindowOptions,
} from "../src/core/context-window.ts";

const baseModel: Model<Api> = {
	id: "model-with-context-options",
	name: "Model with context options",
	api: "openai-responses",
	provider: "test-provider",
	baseUrl: "https://example.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 16_384,
};

describe("context window utilities", () => {
	test("parses raw and compact token counts", () => {
		expect(parseContextWindowValue("400000").value).toBe(400_000);
		expect(parseContextWindowValue("400k").value).toBe(400_000);
		expect(parseContextWindowValue("1m").value).toBe(1_000_000);
		expect(parseContextWindowValue("1.5m").value).toBe(1_500_000);
	});

	test("rejects invalid values", () => {
		expect(parseContextWindowValue("0").error).toContain("positive");
		expect(parseContextWindowValue("abc").error).toContain("Invalid context window");
	});

	test("formats compact labels", () => {
		expect(formatContextWindow(400_000)).toBe("400k");
		expect(formatContextWindow(1_000_000)).toBe("1m");
	});

	test("selects only supported context windows", () => {
		const model = withContextWindowOptions(baseModel, [400_000, 1_000_000]);
		expect(getSupportedContextWindows(model)).toEqual([400_000, 1_000_000]);

		const selected = selectContextWindow(model, 1_000_000);
		expect("error" in selected).toBe(false);
		if (!("error" in selected)) {
			expect(selected.model.contextWindow).toBe(1_000_000);
			expect(selected.model.defaultContextWindow).toBe(400_000);
		}

		const unsupported = selectContextWindow(model, 200_000);
		expect("error" in unsupported).toBe(true);
		if ("error" in unsupported) {
			expect(unsupported.error).toContain("Supported values: 400k, 1m");
		}
	});

	test("optionally resolves GitHub Copilot 1m requests to the advertised long tier", () => {
		const copilotModel = withContextWindowOptions(
			{ ...baseModel, provider: "github-copilot", id: "claude-opus-4.8", contextWindow: 200_000 },
			[200_000, 936_000],
		);

		const exactOnly = selectContextWindow(copilotModel, 1_000_000);
		expect("error" in exactOnly).toBe(true);

		const selected = selectContextWindow(copilotModel, 1_000_000, {
			allowCopilotLongContextFallback: true,
		});
		expect("error" in selected).toBe(false);
		if (!("error" in selected)) {
			expect(selected.contextWindow).toBe(936_000);
			expect(selected.model.contextWindow).toBe(936_000);
			expect(selected.model.defaultContextWindow).toBe(200_000);
		}
	});
});
