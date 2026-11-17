import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	BUILTIN_SLASH_COMMANDS,
	BUNDLED_EXTENSION_SLASH_COMMANDS,
} from "../../packages/coding-agent/src/core/slash-commands.js";
import { ONBOARDING_COPY } from "../../packages/coding-agent/src/modes/interactive/interactive-onboarding.js";

describe("first-run onboarding copy", () => {
	test("is importable from package source through a .js specifier", () => {
		assert.equal(typeof ONBOARDING_COPY, "string");
		assert.notEqual(ONBOARDING_COPY.length, 0);
	});

	test("recommends only slash commands that exist (#5224)", () => {
		const known = new Set([...BUILTIN_SLASH_COMMANDS, ...BUNDLED_EXTENSION_SLASH_COMMANDS].map(({ name }) => name));
		const recommended = [...ONBOARDING_COPY.matchAll(/`\/([\w-]+)/g)].map((match) => match[1]!);
		assert.notDeepEqual(recommended, []);
		assert.deepEqual(
			recommended.filter((name) => !known.has(name)),
			[],
		);
	});
});
