import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { expandPromptTemplate, type PromptTemplate } from "../src/core/prompt-templates.ts";
import { buildSkillCatalog, expandSkillCommand } from "../src/core/skill-catalog.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const SEPARATORS = [
	["space", " "],
	["tab", "\t"],
	["newline", "\n"],
	["CRLF", "\r\n"],
] as const;

const sourceInfo = createSyntheticSourceInfo("/fixture/review.md", { source: "local" });
const reviewTemplate: PromptTemplate = {
	name: "review",
	description: "Review files",
	content: "Review: $ARGUMENTS",
	sourceInfo,
	filePath: "/fixture/review.md",
};

describe("slash commands split their name at the first whitespace (#5192)", () => {
	const harnesses: Harness[] = [];
	const cleanup: Array<() => void> = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (cleanup.length > 0) cleanup.pop()?.();
	});

	for (const [label, separator] of SEPARATORS) {
		test(`expands a prompt template whose arguments follow a ${label} (#5192)`, () => {
			assert.equal(expandPromptTemplate(`/review${separator}src/a.ts`, [reviewTemplate]), "Review: src/a.ts");
		});

		test(`runs an extension command whose arguments follow a ${label} (#5192)`, async () => {
			const runs: string[] = [];
			const harness = await createHarness({
				extensionFactories: [
					(atomic) => {
						atomic.registerCommand("testcmd", {
							description: "Test command",
							handler: async (args) => runs.push(args),
						});
					},
				],
			});
			harnesses.push(harness);

			await harness.session.prompt(`/testcmd${separator}first line\nsecond line`);

			assert.deepEqual(runs, ["first line\nsecond line"]);
			assert.deepEqual(harness.session.messages, []);
		});

		test(`expands a skill whose arguments follow a ${label} (#5192)`, async () => {
			const tempDir = join(tmpdir(), `atomic-5192-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			mkdirSync(tempDir, { recursive: true });
			cleanup.push(() => rmSync(tempDir, { recursive: true, force: true }));
			const filePath = join(tempDir, "SKILL.md");
			writeFileSync(filePath, "---\nname: tdd\ndescription: TDD\n---\n\nSkill body\n");
			const skill: Skill = {
				name: "tdd",
				description: "TDD",
				filePath,
				baseDir: tempDir,
				disableModelInvocation: false,
				sourceInfo: createSyntheticSourceInfo(filePath, { source: "local" }),
			};

			const expanded = await expandSkillCommand(buildSkillCatalog([skill]), `/skill:tdd${separator}fix the\nbug`);

			assert.match(expanded, /^<skill name="tdd" /);
			assert.ok(expanded.endsWith("</skill>\n\nfix the\nbug"), expanded);
		});

		test(`refuses to queue an extension command whose arguments follow a ${label} (#5192)`, async () => {
			const harness = await createHarness({
				extensionFactories: [
					(atomic) => {
						atomic.registerCommand("testcmd", { description: "Test command", handler: async () => {} });
					},
				],
			});
			harnesses.push(harness);

			await assert.rejects(harness.session.followUp(`/testcmd${separator}queued`), /cannot be queued/);
		});

		test(`lets an interactive extension command whose arguments follow a ${label} bypass the queue (#5192)`, () => {
			const runtimeHost = Object.create(IsolatedInteractiveRuntime.prototype) as IsolatedInteractiveRuntime;
			Object.defineProperty(runtimeHost, "getRemoteCommands", {
				value: () => [{ name: "workflow", source: "extension", sourceInfo }],
			});
			const host = { session: { extensionRunner: { getCommand: () => undefined } }, runtimeHost };
			const isExtensionCommand = Reflect.get(InteractiveMode.prototype, "isExtensionCommand") as (
				this: object,
				text: string,
			) => boolean;

			assert.equal(isExtensionCommand.call(host, `/workflow${separator}connect`), true);
		});
	}

	test("keeps a prompt template's multi-line arguments intact (#5192)", () => {
		assert.equal(expandPromptTemplate("/review\nfirst\nsecond", [reviewTemplate]), "Review: first\nsecond");
	});
});
