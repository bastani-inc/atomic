import { readFileSync } from "node:fs";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";

const exampleUrl = new URL("../examples/sdk/12-full-control.ts", import.meta.url);

describe("full-control SDK example", () => {
	test("references an installed pi-ai 0.80.6 model", () => {
		const source = readFileSync(exampleUrl, "utf8");
		const match = source.match(/getModel\("([^"]+)", "([^"]+)"\)/);
		expect(match).not.toBeNull();
		const provider = match?.[1];
		const modelId = match?.[2];
		expect(provider).toBe("anthropic");
		expect(modelId).toBe("claude-sonnet-4-5");
		expect(provider && modelId ? getModel(provider, modelId) : undefined).toBeDefined();
	});
});
