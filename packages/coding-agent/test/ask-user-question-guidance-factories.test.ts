import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";

const SNIPPET = "Ask before deleting anything outside the project";
const homes: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** The public tool factories as a process that has not read the guidance config yet sees them. */
async function freshToolFactories() {
	const home = mkdtempSync(join(tmpdir(), "atomic-ask-guidance-"));
	homes.push(home);
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	mkdirSync(join(home, ".config", "rpiv-ask-user-question"), { recursive: true });
	writeFileSync(
		join(home, ".config", "rpiv-ask-user-question", "config.json"),
		JSON.stringify({ guidance: { promptSnippet: SNIPPET } }),
	);
	vi.resetModules();
	return import("../src/core/tools/index.js");
}

test.each([
	[
		"createAllToolDefinitions",
		(tools: typeof import("../src/core/tools/index.js")) =>
			tools.createAllToolDefinitions(process.cwd()).ask_user_question,
	],
	[
		"createToolDefinition",
		(tools: typeof import("../src/core/tools/index.js")) =>
			tools.createToolDefinition("ask_user_question", process.cwd()),
	],
	[
		"createAllTools",
		(tools: typeof import("../src/core/tools/index.js")) => tools.createAllTools(process.cwd()).ask_user_question,
	],
	[
		"createTool",
		(tools: typeof import("../src/core/tools/index.js")) => tools.createTool("ask_user_question", process.cwd()),
	],
] as const)("%s applies the saved ask_user_question guidance on its first call", async (_factory, create) => {
	const tool = create(await freshToolFactories());
	assert.equal(tool?.promptSnippet, SNIPPET);
});
