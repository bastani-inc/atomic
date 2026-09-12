import assert from "node:assert/strict";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, test, vi } from "vitest";
import { buildSkillCatalog } from "../../packages/coding-agent/src/core/skill-catalog.js";
import { loadSkillsFromDir } from "../../packages/coding-agent/src/core/skills.js";
import { createHarness, getMessageText, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import { createTestExtensionsResult, createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import feedback from "../../packages/feedback/index.js";
import { moduleDir, sleep } from "../helpers/runtime.js";

const cleanups: Array<() => void> = [];
const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
const draft = {
	kind: "enhancement",
	title: "Keyboard navigation",
	body: "### What do you want to change?\n\nReplace [REDACTED]\n\n### Why?\n\nImprove accessibility",
} as const;
const display = `Repository: bastani-inc/atomic\nKind: enhancement\n\n${draft.title}\n\n${draft.body}\n\nPrivacy scrubbed: github-token (1).`;

afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

async function prepareConversation(): Promise<Harness> {
	const loaded = loadSkillsFromDir({
		dir: join(moduleDir(import.meta.url), "../../packages/feedback/skills"),
		source: "bundled",
	});
	assert.deepEqual(loaded.diagnostics, []);
	assert.equal(loaded.skills.length, 1);
	const skills = loaded.skills.map((skill) => ({
		...skill,
		sourceInfo: { ...skill.sourceInfo, configurationOrigin: "bundled" as const },
	}));
	const extensionsResult = await createTestExtensionsResult([feedback]);
	const harness = await createHarness({
		resourceLoader: {
			...createTestResourceLoader({ extensionsResult }),
			getSkills: () => ({ skills, diagnostics: [] }),
			getSkillCatalog: () => buildSkillCatalog(skills),
		},
	});
	cleanups.push(harness.cleanup);
	harness.setResponses([
		(context) => {
			const user = getMessageText(context.messages.findLast((message) => message.role === "user"));
			assert.ok(user.includes('<skill name="feedback"'));
			assert.ok(user.includes("feedback_submit_issue"));
			return fauxAssistantMessage(
				fauxToolCall("feedback_prepare_issue", {
					kind: draft.kind,
					title: draft.title,
					change: `Replace ${secret}`,
					why: "Improve accessibility",
				}),
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			const result = context.messages.findLast((message) => message.role === "toolResult");
			assert.equal(getMessageText(result), display);
			assert.ok(!JSON.stringify(result).includes(secret));
			return fauxAssistantMessage(
				`${getMessageText(result)}\n\nDoes this look right, or would you like edits before I post it?`,
			);
		},
	]);
	await harness.session.prompt("/feedback Add keyboard navigation");
	await new Promise<void>((resolve) => setImmediate(resolve));
	while (harness.session.isStreaming) await sleep(1);
	assert.equal(harness.getPendingResponseCount(), 0);
	assert.ok(getMessageText(harness.session.messages.at(-1)).startsWith(display));
	return harness;
}

// #2799, reviews 3939726085 and 3939726087: exercise registered tools on ordinary session turns.
test.each([false, true])(
	"registered submission binds approval to the displayed draft, topic change=%j",
	async (changeTopic) => {
		const requests: Array<{ url: string; body: string }> = [];
		vi.stubEnv("GITHUB_TOKEN", "synthetic-submission-token");
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-submission-token");
			requests.push({ url, body: String(init.body) });
			return new Response(JSON.stringify({ html_url: "https://github.com/bastani-inc/atomic/issues/42" }));
		});
		const harness = await prepareConversation();
		assert.equal(requests.length, 0);
		if (changeTopic) {
			harness.setResponses([fauxAssistantMessage("Git status lists changed files.")]);
			await harness.session.prompt("Explain git status instead.");
			assert.equal(getMessageText(harness.session.messages.at(-1)), "Git status lists changed files.");
		}
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("feedback_submit_issue", draft), { stopReason: "toolUse" }),
			(context) =>
				fauxAssistantMessage(getMessageText(context.messages.findLast((message) => message.role === "toolResult"))),
		]);
		await harness.session.prompt("Yes.");
		const result = harness.session.messages.findLast((message) => message.role === "toolResult");
		assert.equal(result?.toolName, "feedback_submit_issue");
		assert.ok(result?.details && typeof result.details === "object" && "ok" in result.details);
		assert.equal(result.details.ok, !changeTopic);
		assert.equal(requests.length, changeTopic ? 0 : 1);
		if (changeTopic) {
			assert.ok(getMessageText(result).includes("Clear approval"));
		} else {
			assert.deepEqual(requests, [
				{
					url: "https://api.github.com/repos/bastani-inc/atomic/issues",
					body: JSON.stringify({ title: draft.title, body: draft.body, labels: ["enhancement"] }),
				},
			]);
			assert.equal(
				getMessageText(harness.session.messages.at(-1)),
				"https://github.com/bastani-inc/atomic/issues/42",
			);
		}
	},
);
