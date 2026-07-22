import { describe, expect, test } from "vitest";
import { substituteArgs } from "../src/core/prompt-templates.ts";

describe("all-argument prompt defaults", () => {
	test("uses the default only when all arguments are empty", () => {
		const template = `\${@:-default}\n\${ARGUMENTS:-default}`;
		expect(substituteArgs(template, [])).toBe("default\ndefault");
		expect(substituteArgs(template, ["This", "would", "be", "the", "arguments"])).toBe(
			"This would be the arguments\nThis would be the arguments",
		);
	});
});
