import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";

let home: string | undefined;

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
	if (home) rmSync(home, { recursive: true, force: true });
	home = undefined;
});

test("the first ask_user_question definition an SDK host creates takes its guidance from the config file", async () => {
	home = mkdtempSync(join(tmpdir(), "atomic-ask-user-question-config-"));
	const configDir = join(home, ".config", "rpiv-ask-user-question");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({
			guidance: { promptSnippet: "Ask the team.", promptGuidelines: ["Ask one question at a time."] },
		}),
	);
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.resetModules();
	const { createAskUserQuestionToolDefinition } = await import(
		"../src/core/tools/ask-user-question/ask-user-question.ts"
	);

	const definition = createAskUserQuestionToolDefinition();

	assert.equal(definition.promptSnippet, "Ask the team.");
	assert.deepEqual(definition.promptGuidelines, ["Ask one question at a time."]);
});
