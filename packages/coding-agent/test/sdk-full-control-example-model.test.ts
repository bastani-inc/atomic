import { readFileSync } from "node:fs";
import { builtinModels } from "@bastani/atomic-ai/providers/all";
import { describe, expect, test } from "vitest";

const exampleUrl = new URL("../examples/sdk/12-full-control.ts", import.meta.url);

describe("full-control SDK example", () => {
	test("references the Claude Sonnet model with the Anthropic API when the catalog lists it", ({ skip }) => {
		const source = readFileSync(exampleUrl, "utf8");
		const match = source.match(/getModel\("([^"]+)", "([^"]+)"\)/);
		expect(match?.slice(1)).toEqual(["anthropic", "claude-sonnet-4-5"]);
		const model = builtinModels().getModel("anthropic", "claude-sonnet-4-5");
		if (!model) return skip("anthropic/claude-sonnet-4-5 is not in the generated model catalog");
		expect(model.api).toBe("anthropic-messages");
	});
});
