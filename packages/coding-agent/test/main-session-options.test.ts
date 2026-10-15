import assert from "node:assert/strict";
import type { Model } from "@bastani/pi-ai";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { buildSessionOptions } from "../src/main-session-options.ts";
import { fakeModelRuntime } from "./model-runtime-test-utils.ts";

function build(args: string[]) {
	return buildSessionOptions(parseArgs(args), [], false, fakeModelRuntime(), SettingsManager.inMemory());
}

describe("buildSessionOptions --provider", () => {
	// #10236
	it("reports an error when --provider is given without --model", () => {
		const { options, diagnostics } = build(["--provider", "anthropic"]);

		expect(options.model).toBeUndefined();
		expect(diagnostics).toEqual([
			{
				type: "error",
				message: "--provider requires --model (for example: --provider anthropic --model <pattern>)",
			},
		]);
	});

	it("does not complain when --model accompanies --provider or no provider is given", () => {
		expect(build(["--provider", "anthropic", "--model", "sonnet"]).diagnostics.map((d) => d.message)).not.toContain(
			"--provider requires --model (for example: --provider anthropic --model <pattern>)",
		);
		expect(build([]).diagnostics).toEqual([]);
	});
});

describe("buildSessionOptions --api-key", () => {
	it("does not let stored credentials choose the provider for a bare model id (#3624)", () => {
		const gateway: Model<"openai-completions"> = {
			id: "anthropic/claude-opus-5.5",
			name: "Claude Opus 5.5",
			api: "openai-completions",
			provider: "vercel-ai-gateway",
			baseUrl: "https://gateway.example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		};
		const modelRuntime = fakeModelRuntime({
			getModels: () => [gateway, { ...gateway, provider: "openrouter" }],
			hasConfiguredAuth: (provider: string) => provider === "vercel-ai-gateway",
		});
		const run = (args: string[]) =>
			buildSessionOptions(parseArgs(args), [], false, modelRuntime, SettingsManager.inMemory());

		assert.equal(run(["--model", "anthropic/claude-opus-5.5"]).options.model?.provider, "vercel-ai-gateway");

		const { options, diagnostics } = run(["--model", "anthropic/claude-opus-5.5", "--api-key", "sk-test"]);
		assert.equal(options.model, undefined);
		assert.match(diagnostics.map((d) => d.message).join("\n"), /--api-key does not choose a provider\./);
	});
});
