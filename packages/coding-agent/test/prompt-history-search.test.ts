import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import type { Component } from "@bastani/atomic-tui";
import { setKeybindings, stripTerminalSequences } from "@bastani/atomic-tui";
import { Type } from "typebox";
import { beforeAll, beforeEach, describe, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { PromptTemplate } from "../src/core/prompt-templates.ts";
import { buildSkillCatalog } from "../src/core/skill-catalog.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import {
	PromptHistorySelectorComponent,
	promptAge,
	promptHistoryEntries,
	sessionPromptsFromEntries,
} from "../src/modes/interactive/components/prompt-history-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, getUserTexts } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const minutesAgo = (minutes: number) => NOW - minutes * 60_000;

function lines(component: Component, width: number): string[] {
	return component.render(width).map((line) => stripTerminalSequences(line).replace(/\s+$/, ""));
}

describe("prompt history search (ctrl+r) (#5224)", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("lists the prompts up and down walk through, newest first and each once, then older session prompts", () => {
		const entries = promptHistoryEntries(
			["ship it", "fix the login bug", "ship it"],
			[
				{ text: "plan the release", sentAt: minutesAgo(90) },
				{ text: "ship it", sentAt: minutesAgo(60) },
				{ text: "audit the schema", sentAt: minutesAgo(45) },
				{ text: "fix the login bug", sentAt: minutesAgo(30) },
				{ text: "ship it", sentAt: minutesAgo(2) },
				{ text: "fix the login bug", sentAt: minutesAgo(75) },
				{ text: "  ", sentAt: minutesAgo(1) },
			],
		);
		assert.deepEqual(entries, [
			{ text: "ship it", sentAt: minutesAgo(2) },
			{ text: "fix the login bug", sentAt: minutesAgo(30) },
			{ text: "audit the schema", sentAt: minutesAgo(45) },
			{ text: "plan the release", sentAt: minutesAgo(90) },
		]);
	});

	it("keeps a prompt typed literally even when another command expands to the same text (#5347)", () => {
		assert.deepEqual(
			promptHistoryEntries(
				["Please fix the bug", "/fixbug"],
				[
					{ text: "/fixbug", expandedText: "Please fix the bug", sentAt: minutesAgo(5) },
					{ text: "Please fix the bug", sentAt: minutesAgo(1) },
				],
			),
			[
				{ text: "Please fix the bug", sentAt: minutesAgo(1) },
				{ text: "/fixbug", sentAt: minutesAgo(5) },
			],
		);
	});

	it("says how long ago a prompt was sent", () => {
		assert.equal(promptAge(20_000), "just now");
		assert.equal(promptAge(59_999), "just now");
		assert.equal(promptAge(60_000), "1m ago");
		assert.equal(promptAge(5 * 60_000), "5m ago");
		assert.equal(promptAge(59 * 60_000), "59m ago");
		assert.equal(promptAge(60 * 60_000), "1h ago");
		assert.equal(promptAge(3 * 3_600_000), "3h ago");
		assert.equal(promptAge(23 * 3_600_000), "23h ago");
		assert.equal(promptAge(24 * 3_600_000), "1d ago");
		assert.equal(promptAge(2 * 86_400_000), "2d ago");
		assert.equal(promptAge(6 * 86_400_000), "6d ago");
		assert.equal(promptAge(7 * 86_400_000), "1w ago");
		assert.equal(promptAge(29 * 86_400_000), "4w ago");
		assert.equal(promptAge(30 * 86_400_000), "1mo ago");
		assert.equal(promptAge(364 * 86_400_000), "12mo ago");
		assert.equal(promptAge(365 * 86_400_000), "1y ago");
		assert.equal(promptAge(730 * 86_400_000), "2y ago");
		assert.equal(promptAge(-5), "just now");
	});

	for (const width of [80, 160]) {
		it(`draws the shared picker at ${width} columns: title, search box, ages and one hint line of live keys`, () => {
			const selector = new PromptHistorySelectorComponent(
				[
					{ text: "ship it", sentAt: minutesAgo(2) },
					{ text: "fix the login bug\nand the redirect", sentAt: minutesAgo(30) },
					{ text: "typed before a restart" },
				],
				{ onSelect: () => {}, onCancel: () => {}, now: () => NOW },
			);
			const out = lines(selector, width);
			assert.ok(
				out.some((line) => line.trim() === "Search prompts"),
				out.join("\n"),
			);
			assert.ok(out.some((line) => line.includes("⌕ Filter prompts…")));
			const first = out.find((line) => line.includes("❯ ship it"));
			assert.ok(first?.endsWith("2m ago"), out.join("\n"));
			assert.ok(out.some((line) => line.includes("fix the login bug and the redirect") && line.endsWith("30m ago")));
			assert.ok(out.some((line) => line.trim() === "typed before a restart"));
			assert.equal(out.at(-2)?.trim(), "↑↓ select · enter use · type to search · esc cancel");
			assert.ok(out.every((line) => line.length <= width));
		});
	}

	it("typing filters, enter hands back the whole prompt, and esc clears a search before it cancels", () => {
		const chosen: string[] = [];
		let cancelled = 0;
		const selector = new PromptHistorySelectorComponent(
			[{ text: "ship it" }, { text: "fix the login bug\nand the redirect" }],
			{ onSelect: (text) => chosen.push(text), onCancel: () => cancelled++, now: () => NOW },
		);
		for (const ch of "redirect") selector.handleInput(ch);
		assert.ok(lines(selector, 100).some((line) => line.includes("❯ fix the login bug and the redirect")));
		selector.handleInput("\x1b");
		assert.equal(cancelled, 0);
		const cleared = lines(selector, 100);
		assert.ok(cleared.some((line) => line.includes("❯ fix the login bug and the redirect")));
		assert.ok(cleared.some((line) => line.trim() === "ship it"));
		selector.handleInput("\x1b");
		assert.equal(cancelled, 1);
		const again = new PromptHistorySelectorComponent([{ text: "fix the login bug\nand the redirect" }], {
			onSelect: (text) => chosen.push(text),
			onCancel: () => {},
		});
		again.handleInput("\r");
		assert.deepEqual(chosen, ["fix the login bug\nand the redirect"]);
	});

	it("requires the advertised confirm key before choosing a prompt (#5347)", () => {
		const chosen: string[] = [];
		const selector = new PromptHistorySelectorComponent([{ text: "inspect the menu" }], {
			onSelect: (text) => chosen.push(text),
			onCancel: () => {},
		});
		selector.handleInput("\x1b[C");
		assert.deepEqual(chosen, []);
		selector.handleInput("\r");
		assert.deepEqual(chosen, ["inspect the menu"]);
	});

	it("says there are no prompts yet when there are none", () => {
		const selector = new PromptHistorySelectorComponent([], { onSelect: () => {}, onCancel: () => {} });
		assert.ok(lines(selector, 80).some((line) => line.trim() === "No prompts yet"));
	});

	it("ctrl+r puts the chosen prompt in the composer without sending it, and esc leaves the draft alone", () => {
		let shown: Component | undefined;
		let closed = 0;
		const editor = {
			text: "my draft",
			getHistory: () => ["ship it", "fix the login bug"],
			setText(text: string) {
				this.text = text;
			},
		};
		let sent = 0;
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			editor,
			runtimeHost: {
				session: {
					sessionManager: {
						getEntries: () => [
							{
								type: "message",
								id: "u1",
								parentId: null,
								timestamp: new Date(Date.now() - 4 * 60_000 - 5_000).toISOString(),
								message: { role: "user", content: [{ type: "text", text: "fix the login bug" }] },
							},
							{
								type: "message",
								id: "a1",
								parentId: "u1",
								timestamp: new Date(Date.now() - 3 * 60_000).toISOString(),
								message: { role: "assistant", content: [{ type: "text", text: "done" }] },
							},
						],
					},
					prompt: () => sent++,
				},
			},
			ui: { requestRender: () => {} },
			showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
				shown = create(() => closed++).component;
			},
		}) as InteractiveMode;

		mode.showPromptHistorySearch();
		assert.ok(shown);
		const out = lines(shown, 100);
		assert.ok(out.some((line) => line.includes("❯ ship it")));
		assert.ok(out.some((line) => line.includes("fix the login bug") && line.endsWith("4m ago")));
		shown.handleInput?.("\x1b[B");
		shown.handleInput?.("\r");
		assert.equal(editor.text, "fix the login bug");
		assert.equal(closed, 1);
		assert.equal(sent, 0);

		editor.text = "my draft";
		mode.showPromptHistorySearch();
		shown.handleInput?.("\x1b");
		assert.equal(editor.text, "my draft");
		assert.equal(closed, 2);
	});

	it("binds ctrl+r to the search by default", () => {
		assert.deepEqual(new KeybindingsManager().getKeys("app.history.search"), ["ctrl+r"]);
	});

	it("lists expanded prompt templates, skill commands and input-hook rewrites once as typed with their age, including queued prompts", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const holdTool: AgentTool = {
			name: "hold",
			label: "Hold",
			description: "Hold turn",
			parameters: Type.Object({}),
			execute: async () => {
				entered.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "held" }], details: {} };
			},
		};
		const template: PromptTemplate = {
			name: "fixbug",
			description: "Fix a bug",
			content: "Please fix the bug: $ARGUMENTS\nRun the tests afterwards.",
			filePath: "/virtual/fixbug.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/fixbug.md", {
				source: "local",
				scope: "project",
				origin: "top-level",
			}),
		};
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("input", (event) =>
					event.text === "shorthand check"
						? { action: "transform", text: "Run the full check suite." }
						: { action: "continue" },
				);
			},
		]);
		const baseLoader = createTestResourceLoader({ extensionsResult });
		let catalog = buildSkillCatalog([]);
		let skills: Skill[] = [];
		const harness = await createHarness({
			tools: [holdTool],
			resourceLoader: {
				...baseLoader,
				getPrompts: () => ({ prompts: [template], diagnostics: [] }),
				getSkills: () => ({ skills, diagnostics: [] }),
				getSkillCatalog: () => catalog,
			},
		});
		try {
			const skillPath = join(harness.tempDir, "skills", "tdd", "SKILL.md");
			mkdirSync(join(skillPath, ".."), { recursive: true });
			writeFileSync(
				skillPath,
				"---\nname: tdd\ndescription: Test-driven development\n---\n\nWrite a failing test first.\n",
			);
			const tddSkill: Skill = {
				name: "tdd",
				description: "Test-driven development",
				filePath: skillPath,
				baseDir: join(skillPath, ".."),
				disableModelInvocation: false,
				sourceInfo: createSyntheticSourceInfo(skillPath, {
					source: "local",
					scope: "project",
					origin: "top-level",
				}),
			};
			skills = [tddSkill];
			catalog = buildSkillCatalog([tddSkill], [tddSkill]);

			harness.setResponses([
				fauxAssistantMessage("fixed"),
				fauxAssistantMessage("tested"),
				fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("steered"),
				fauxAssistantMessage("followed up"),
				fauxAssistantMessage("queued image"),
				fauxAssistantMessage("done"),
				fauxAssistantMessage("with image"),
			]);

			const editorHistory: string[] = [];
			const recordHistory = (text: string) => {
				editorHistory.unshift(text);
			};

			recordHistory("/fixbug login redirect");
			await harness.session.prompt("/fixbug login redirect");

			recordHistory("/skill:tdd edge cases");
			await harness.session.prompt("/skill:tdd edge cases");

			recordHistory("shorthand check");
			const turn = harness.session.prompt("shorthand check");
			await entered.promise;

			recordHistory("/fixbug queued steer");
			await harness.session.prompt("/fixbug queued steer", { streamingBehavior: "steer" });

			recordHistory("/skill:tdd queued followup");
			await harness.session.followUp("/skill:tdd queued followup");

			recordHistory("check queued screenshot");
			await harness.session.followUp("check queued screenshot", [
				{ type: "image", data: "AAAA", mimeType: "image/x-unsupported" },
			]);

			release.resolve();
			await turn;

			recordHistory("plain prompt two");
			await harness.session.prompt("plain prompt two");

			recordHistory("check screenshot");
			await harness.session.prompt("check screenshot", {
				images: [{ type: "image", data: "AAAA", mimeType: "image/x-unsupported" }],
			});

			const modelPrompts = getUserTexts(harness);
			assert.equal(modelPrompts[0], "Please fix the bug: login redirect\nRun the tests afterwards.");
			assert.match(modelPrompts[1] ?? "", /^<skill name="tdd"/);
			assert.equal(modelPrompts[2], "Run the full check suite.");
			assert.equal(modelPrompts[3], "Please fix the bug: queued steer\nRun the tests afterwards.");
			assert.match(modelPrompts[4] ?? "", /^<skill name="tdd"[\s\S]*queued followup$/);
			assert.match(modelPrompts[5] ?? "", /^check queued screenshot\n\n\[Image/);
			assert.equal(modelPrompts[6], "plain prompt two");
			assert.match(modelPrompts[7] ?? "", /^check screenshot\n\n\[Image/);

			const sessionPrompts = sessionPromptsFromEntries(harness.session.sessionManager.getEntries());
			assert.deepEqual(
				sessionPrompts.map((entry) => entry.text),
				[
					"/fixbug login redirect",
					"/skill:tdd edge cases",
					"shorthand check",
					"/fixbug queued steer",
					"/skill:tdd queued followup",
					"check queued screenshot",
					"plain prompt two",
					"check screenshot",
				],
			);
			assert.ok(sessionPrompts.every((entry) => typeof entry.sentAt === "number" && Number.isFinite(entry.sentAt)));

			const entries = promptHistoryEntries(editorHistory, sessionPrompts);
			assert.deepEqual(
				entries.map((entry) => entry.text),
				[
					"check screenshot",
					"plain prompt two",
					"check queued screenshot",
					"/skill:tdd queued followup",
					"/fixbug queued steer",
					"shorthand check",
					"/skill:tdd edge cases",
					"/fixbug login redirect",
				],
			);
			assert.ok(entries.every((entry) => typeof entry.sentAt === "number" && Number.isFinite(entry.sentAt)));
			assert.deepEqual(promptHistoryEntries([...modelPrompts].reverse(), sessionPrompts), entries);

			const selector = new PromptHistorySelectorComponent(entries, {
				onSelect: () => {},
				onCancel: () => {},
			});
			const rendered = lines(selector, 100);
			assert.ok(rendered.some((line) => line.includes("/fixbug login redirect") && line.endsWith("just now")));
			assert.ok(rendered.some((line) => line.includes("/skill:tdd edge cases") && line.endsWith("just now")));
			assert.ok(!rendered.some((line) => line.includes("Please fix the bug")));
			assert.ok(!rendered.some((line) => line.includes("<skill")));
			assert.ok(!rendered.some((line) => line.includes("Run the full check suite")));
		} finally {
			release.resolve();
			await harness.cleanup();
		}
	});
});
