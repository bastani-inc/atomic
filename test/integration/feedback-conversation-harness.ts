import assert from "node:assert/strict";
import { join } from "node:path";
import { buildSkillCatalog } from "../../packages/coding-agent/src/core/skill-catalog.js";
import { loadSkillsFromDir } from "../../packages/coding-agent/src/core/skills.js";
import { createHarness, getMessageText, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import { createTestExtensionsResult, createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import feedback from "../../packages/feedback/index.js";
import { moduleDir, sleep } from "../helpers/runtime.js";

export async function createFeedbackConversationHarness(): Promise<Harness> {
	const loaded = loadSkillsFromDir({
		dir: join(moduleDir(import.meta.url), "../../packages/feedback/skills"),
		source: "bundled",
	});
	assert.deepEqual(loaded.diagnostics, []);
	assert.deepEqual(
		loaded.skills.map(({ name }) => name),
		["feedback"],
	);
	const skills = loaded.skills.map((skill) => ({
		...skill,
		sourceInfo: { ...skill.sourceInfo, configurationOrigin: "bundled" as const },
	}));
	const extensionsResult = await createTestExtensionsResult([feedback]);
	return createHarness({
		resourceLoader: {
			...createTestResourceLoader({ extensionsResult }),
			getSkills: () => ({ skills, diagnostics: [] }),
			getSkillCatalog: () => buildSkillCatalog(skills),
		},
	});
}

export async function settleTurn(harness: Harness): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	while (harness.session.isStreaming) await sleep(1);
}

export function transcriptText(harness: Harness): string {
	return harness.session.messages.map(getMessageText).join("\n");
}
export function assistantMessages(harness: Harness): string[] {
	return harness.session.messages.filter((message) => message.role === "assistant").map(getMessageText);
}

/**
 * Any rendered GitHub issue link. The pattern is deliberately host-free: a leaked link is a failure on any
 * host, and a host literal in a substring or unanchored regular-expression check is what CodeQL reports as
 * incomplete URL sanitization (code scanning alerts 200 and 201 on #2849).
 */
export const ISSUE_LINK = /\/issues\/[1-9]\d*\b/u;

export function assertNoIssueLink(harness: Harness): void {
	assert.doesNotMatch(transcriptText(harness), ISSUE_LINK);
}
