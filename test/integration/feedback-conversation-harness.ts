import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillCatalog } from "../../packages/coding-agent/src/core/skill-catalog.ts";
import type { Skill } from "../../packages/coding-agent/src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../packages/coding-agent/src/core/source-info.ts";
import { createHarness, getMessageText, type Harness } from "../../packages/coding-agent/test/suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../packages/coding-agent/test/utilities.ts";
import feedback from "../../packages/feedback/index.ts";

export async function createFeedbackConversationHarness(): Promise<Harness> {
	const root = join(tmpdir(), `atomic-feedback-followup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const filePath = join(root, "feedback", "SKILL.md");
	mkdirSync(join(filePath, ".."), { recursive: true });
	writeFileSync(
		filePath,
		"---\nname: feedback\ndescription: Give feedback\n---\n\nPrepare a reviewable feedback draft.\n",
	);
	const skill: Skill = {
		name: "feedback",
		description: "Give feedback",
		filePath,
		baseDir: join(filePath, ".."),
		disableModelInvocation: false,
		sourceInfo: createSyntheticSourceInfo(filePath, {
			source: "/packages/feedback",
			scope: "temporary",
			origin: "package",
			configurationOrigin: "bundled",
		}),
	};
	const extensionsResult = await createTestExtensionsResult([feedback], root);
	const base = createTestResourceLoader({ extensionsResult });
	const harness = await createHarness({
		resourceLoader: {
			...base,
			getSkills: () => ({ skills: [skill], diagnostics: [] }),
			getSkillCatalog: () => buildSkillCatalog([skill], [skill]),
		},
	});
	const cleanup = harness.cleanup;
	harness.cleanup = () => {
		cleanup();
		rmSync(root, { recursive: true, force: true });
	};
	return harness;
}

export function transcriptText(harness: Harness): string {
	return harness.session.messages.map(getMessageText).join("\n");
}
export function assistantMessages(harness: Harness): string[] {
	return harness.session.messages.filter((message) => message.role === "assistant").map(getMessageText);
}
