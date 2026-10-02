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
