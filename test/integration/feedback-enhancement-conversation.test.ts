import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { buildSkillCatalog } from "../../packages/coding-agent/src/core/skill-catalog.ts";
import type { Skill } from "../../packages/coding-agent/src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../packages/coding-agent/src/core/source-info.ts";
import { createHarness, getMessageText, type Harness } from "../../packages/coding-agent/test/suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../packages/coding-agent/test/utilities.ts";
import feedback, { FEEDBACK_USAGE } from "../../packages/feedback/index.ts";

const cleanups: Array<() => void> = [];

const skillSources = {
	project: { source: "local", scope: "project", origin: "top-level", configurationOrigin: "atomic" },
	builtin: { source: "/packages/feedback", scope: "temporary", origin: "package", configurationOrigin: "bundled" },
} as const;

function skill(filePath: string, source: keyof typeof skillSources, body: string): Skill {
	mkdirSync(join(filePath, ".."), { recursive: true });
	writeFileSync(filePath, `---\nname: feedback\ndescription: ${source} feedback\n---\n\n${body}\n`);
	return {
		name: "feedback",
		description: `${source} feedback`,
		filePath,
		baseDir: join(filePath, ".."),
		disableModelInvocation: false,
		sourceInfo: createSyntheticSourceInfo(filePath, skillSources[source]),
	};
}

async function feedbackHarness(collision = false): Promise<Harness> {
	const root = join(tmpdir(), `atomic-feedback-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const builtin = skill(join(root, "builtin", "SKILL.md"), "builtin", "BUNDLED FEEDBACK INSTRUCTIONS");
	const project = collision ? skill(join(root, "project", "SKILL.md"), "project", "LOCAL COLLISION BODY") : undefined;
	const skills = project ? [project, builtin] : [builtin];
	const catalog = buildSkillCatalog(skills, project ? [project] : skills);
	const extensionsResult = await createTestExtensionsResult([feedback], root);
	const base = createTestResourceLoader({ extensionsResult });
	const resourceLoader = {
		...base,
		getSkills: () => ({ skills, diagnostics: [] }),
		getSkillCatalog: () => catalog,
	};
	const harness = await createHarness({ resourceLoader });
	cleanups.push(harness.cleanup, () => rmSync(root, { recursive: true, force: true }));
	return harness;
}

function messageText(harness: Harness): string {
	return harness.session.messages.map(getMessageText).join("\n");
}

async function settleTurn(harness: Harness): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	while (harness.session.isStreaming) await new Promise((resolve) => setTimeout(resolve, 1));
}

describe("feedback command conversation entry", () => {
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	it.each(["/feedback", "/feedback   "])("shows usage without a model turn for %j", async (command) => {
		const harness = await feedbackHarness();
		harness.setResponses([fauxAssistantMessage("must remain queued")]);

		await harness.session.prompt(command);

		expect(messageText(harness)).toContain(FEEDBACK_USAGE);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.messages.some((message) => message.role === "assistant")).toBe(false);
	});

	it("starts one ordinary turn with the exact bundled skill and original prompt", async () => {
		const harness = await feedbackHarness(true);
		let expanded = "";
		harness.setResponses([
			(context) => {
				expanded = getMessageText(context.messages.find((message) => message.role === "user"));
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("/feedback Add  keyboard navigation");
		await settleTurn(harness);

		expect(expanded).toContain('<skill name="feedback@builtin"');
		expect(expanded).toContain("BUNDLED FEEDBACK INSTRUCTIONS");
		expect(expanded).not.toContain("LOCAL COLLISION BODY");
		expect(expanded).toContain("Add  keyboard navigation");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("preserves feedback as a follow-up turn while another turn is streaming", async () => {
		const harness = await feedbackHarness();
		let releaseFirst = () => {};
		const firstRelease = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let markFirstStarted = () => {};
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		let expandedFollowUp = "";
		harness.setResponses([
			async () => {
				markFirstStarted();
				await firstRelease;
				return fauxAssistantMessage("first turn done");
			},
			(context) => {
				expandedFollowUp = getMessageText(context.messages.findLast((message) => message.role === "user"));
				return fauxAssistantMessage("feedback turn done");
			},
		]);

		const firstPrompt = harness.session.prompt("start a long turn");
		await firstStarted;
		expect(harness.session.isStreaming).toBe(true);
		await harness.session.prompt("/feedback Preserve  this request", { streamingBehavior: "steer" });
		releaseFirst();
		await firstPrompt;
		await settleTurn(harness);

		expect(expandedFollowUp).toContain('<skill name="feedback"');
		expect(expandedFollowUp).toContain("Preserve  this request");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("continues clarification through a normal user message and prepares an enhancement", async () => {
		const harness = await feedbackHarness();
		harness.setResponses([fauxAssistantMessage("Why would keyboard navigation help?")]);

		await harness.session.prompt("/feedback Add keyboard navigation");
		await settleTurn(harness);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(messageText(harness)).not.toContain("toolResult");

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("feedback_prepare_issue", {
					kind: "enhancement",
					title: "Keyboard navigation",
					change: "Add keyboard navigation",
					why: "Improve accessibility",
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				const result = context.messages.findLast((message) => message.role === "toolResult");
				return fauxAssistantMessage(
					`## Keyboard navigation\n\n${getMessageText(result)}\n\nWould you like edits or approval?`,
				);
			},
		]);
		await harness.session.prompt("It improves accessibility");

		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
		expect(messageText(harness)).toContain("### What do you want to change?\n\nAdd keyboard navigation");
		expect(messageText(harness)).toContain("Would you like edits or approval?");
	});

	it("returns validation errors and privacy-safe prepared details through model tool calls", async () => {
		const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
		const harness = await feedbackHarness();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("feedback_prepare_issue", { kind: "enhancement", title: "Incomplete", change: "Change it" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("validation shown"),
		]);
		await harness.session.prompt("prepare incomplete feedback");
		const invalid = harness.session.messages.find((message) => message.role === "toolResult");
		expect(invalid?.isError).toBe(true);
		expect(getMessageText(invalid)).toBe("Why? is required");

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("feedback_prepare_issue", {
					kind: "enhancement",
					title: "Safe title",
					change: `Replace ${secret}`,
					why: "Protect users",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("prepared"),
		]);
		await harness.session.prompt("prepare complete feedback");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		const safe = results.at(-1);
		expect(safe?.details).toEqual({
			repository: { owner: "bastani-inc", repo: "atomic" },
			kind: "enhancement",
			title: "Safe title",
			body: "### What do you want to change?\n\nReplace [REDACTED]\n\n### Why?\n\nProtect users",
			privacySummary: [{ category: "github-token", count: 1 }],
		});
		expect(getMessageText(safe)).toContain("[REDACTED]");
		expect(JSON.stringify(safe)).not.toContain(secret);
	});
});
