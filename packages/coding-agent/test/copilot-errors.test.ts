import { describe, expect, test } from "vitest";
import { formatCopilotProviderError, parseCopilotPromptLimitError } from "../src/core/copilot-errors.ts";

describe("GitHub Copilot error guidance", () => {
	test("adds long-context entitlement guidance to Copilot prompt-limit errors", () => {
		const message = formatCopilotProviderError(
			"github-copilot",
			"prompt token count of 500001 exceeds the limit of 400000",
		);

		expect(message).toContain("prompt token count of 500001 exceeds the limit of 400000");
		expect(message).toContain("API/server context cap");
		expect(message).toContain("X-GitHub-Api-Version: 2026-06-01");
		expect(message).toContain("long-context/usage-based billing entitlement");
		expect(message).toContain("higher-cost AI credits");
	});

	test("parses prompt and limit token counts", () => {
		expect(parseCopilotPromptLimitError("prompt token count of 500,001 exceeds the limit of 400,000")).toEqual({
			promptTokens: 500_001,
			limitTokens: 400_000,
		});
	});

	test("does not change non-Copilot provider errors", () => {
		const original = "prompt token count of 500001 exceeds the limit of 400000";
		expect(formatCopilotProviderError("openai", original)).toBe(original);
	});
});
