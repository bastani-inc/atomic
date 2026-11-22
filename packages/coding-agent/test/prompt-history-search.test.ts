import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import type { Component } from "@bastani/atomic-tui";
import { setKeybindings, stripTerminalSequences, TuiMainScreen } from "@bastani/atomic-tui";
import { Type } from "typebox";
import { beforeAll, beforeEach, describe, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { PromptTemplate } from "../src/core/prompt-templates.ts";
import { buildSkillCatalog } from "../src/core/skill-catalog.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { promptHistoryFor } from "../src/modes/interactive/components/agent-prompt-history.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import {
	PromptHistorySelectorComponent,
	promptAge,
	promptHistoryEntries,
	sessionPromptsFromEntries,
} from "../src/modes/interactive/components/prompt-history-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";
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

	it("lists the session's prompts newest first and each once", () => {
		const entries = promptHistoryEntries([
			{ text: "plan the release", sentAt: minutesAgo(90) },
			{ text: "ship it", sentAt: minutesAgo(60) },
			{ text: "audit the schema", sentAt: minutesAgo(45) },
			{ text: "fix the login bug", sentAt: minutesAgo(30) },
			{ text: "ship it", sentAt: minutesAgo(2) },
			{ text: "fix the login bug", sentAt: minutesAgo(75) },
			{ text: "  ", sentAt: minutesAgo(1) },
		]);
		assert.deepEqual(entries, [
			{ text: "ship it", sentAt: minutesAgo(2) },
			{ text: "fix the login bug", sentAt: minutesAgo(30) },
			{ text: "audit the schema", sentAt: minutesAgo(45) },
			{ text: "plan the release", sentAt: minutesAgo(90) },
		]);
	});

	it("keeps a prompt typed literally even when another command expands to the same text (#5347)", () => {
		assert.deepEqual(
			promptHistoryEntries([
				{ text: "/fixbug", sentAt: minutesAgo(5) },
				{ text: "Please fix the bug", sentAt: minutesAgo(1) },
			]),
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
							{
								type: "message",
								id: "u2",
								parentId: "a1",
								timestamp: new Date(Date.now() - 60_000).toISOString(),
								message: { role: "user", content: [{ type: "text", text: "ship it" }] },
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

	it("ctrl+r searches the history Up recalls for the agent the prompt writes to: a viewed subagent's prompts, never main's", () => {
		let shown: Component | undefined;
		const editor = new CustomEditor(
			new TuiMainScreen(new RecordingTerminal()),
			getEditorTheme(),
			new KeybindingsManager(),
		);
		editor.addToHistory("a main prompt");
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			editor,
			defaultEditor: editor,
			runtimeHost: {
				session: {
					sessionManager: {
						getEntries: () => [
							{
								type: "message",
								id: "u1",
								parentId: null,
								timestamp: new Date(Date.now() - 60_000).toISOString(),
								message: { role: "user", content: [{ type: "text", text: "a main prompt" }] },
							},
						],
					},
				},
			},
			ui: { requestRender: () => {} },
			showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
				shown = create(() => {}).component;
			},
		}) as InteractiveMode;

		promptHistoryFor(editor).viewAgent("task-1", ["trace the loader", "and the cache"]);
		editor.addToHistory("typed to the subagent");
		mode.showPromptHistorySearch();
		assert.ok(shown);
		const out = lines(shown, 100);
		assert.ok(
			out.some((line) => line.trim() === "❯ typed to the subagent"),
			out.join("\n"),
		);
		assert.ok(out.some((line) => line.trim() === "and the cache"));
		assert.ok(out.some((line) => line.trim() === "trace the loader"));
		assert.ok(!out.some((line) => line.includes("a main prompt")));
		shown.handleInput?.("\x1b[B");
		shown.handleInput?.("\r");
		assert.equal(editor.getText(), "and the cache");

		promptHistoryFor(editor).viewMain();
		mode.showPromptHistorySearch();
		const main = lines(shown, 100);
		assert.ok(main.some((line) => line.includes("❯ a main prompt")));
		assert.ok(!main.some((line) => line.includes("trace the loader") || line.includes("typed to the subagent")));
	});

	it("binds ctrl+r to the search by default", () => {
		assert.deepEqual(new KeybindingsManager().getKeys("app.history.search"), ["ctrl+r"]);
	});

	it("lists expanded prompt templates and skill commands once as typed and input-hook rewrites as recorded, with their age, including queued prompts", async () => {
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
			(atomic) => {
				atomic.on("input", (event) =>
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

			await harness.session.prompt("/fixbug login redirect");

			await harness.session.prompt("/skill:tdd edge cases");

			const turn = harness.session.prompt("shorthand check");
			await entered.promise;

			await harness.session.prompt("/fixbug queued steer", { streamingBehavior: "steer" });

			await harness.session.followUp("/skill:tdd queued followup");

			await harness.session.followUp("check queued screenshot", [
				{ type: "image", data: "AAAA", mimeType: "image/x-unsupported" },
			]);

			release.resolve();
			await turn;

			await harness.session.prompt("plain prompt two");

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
					"Run the full check suite.",
					"/fixbug queued steer",
					"/skill:tdd queued followup",
					"check queued screenshot",
					"plain prompt two",
					"check screenshot",
				],
			);
			assert.ok(sessionPrompts.every((entry) => typeof entry.sentAt === "number" && Number.isFinite(entry.sentAt)));

			const entries = promptHistoryEntries(sessionPrompts);
			assert.deepEqual(entries.map((entry) => entry.text).sort(), sessionPrompts.map((entry) => entry.text).sort());
			assert.ok(entries.every((entry) => typeof entry.sentAt === "number" && Number.isFinite(entry.sentAt)));

			const selector = new PromptHistorySelectorComponent(entries, {
				onSelect: () => {},
				onCancel: () => {},
			});
			const rendered = lines(selector, 100);
			assert.ok(rendered.some((line) => line.includes("/fixbug login redirect") && line.endsWith("just now")));
			assert.ok(rendered.some((line) => line.includes("/skill:tdd edge cases") && line.endsWith("just now")));
			assert.ok(!rendered.some((line) => line.includes("Please fix the bug")));
			assert.ok(!rendered.some((line) => line.includes("<skill")));
		} finally {
			release.resolve();
			await harness.cleanup();
		}
	});

	it("records and searches the prompt an input hook redacted, never the typed text, including queued and paused prompts (#5347)", async () => {
		const secret = "synthetic-secret-123";
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
			content: "Please fix the bug: $ARGUMENTS",
			filePath: "/virtual/fixbug.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/fixbug.md", {
				source: "local",
				scope: "project",
				origin: "top-level",
			}),
		};
		const hookInputs: string[] = [];
		const extensionsResult = await createTestExtensionsResult([
			(atomic) => {
				atomic.on("input", (event) => {
					hookInputs.push(event.text);
					return event.text.includes(secret)
						? { action: "transform", text: event.text.replaceAll(secret, "[redacted]") }
						: { action: "continue" };
				});
			},
		]);
		const baseLoader = createTestResourceLoader({ extensionsResult });
		const harness = await createHarness({
			tools: [holdTool],
			resourceLoader: { ...baseLoader, getPrompts: () => ({ prompts: [template], diagnostics: [] }) },
		});
		try {
			harness.setResponses([
				fauxAssistantMessage("plain"),
				fauxAssistantMessage("templated"),
				fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("steered"),
				fauxAssistantMessage("followed up"),
				fauxAssistantMessage("queued template"),
				fauxAssistantMessage("done"),
				fauxAssistantMessage("after pause"),
				fauxAssistantMessage("paused delivered"),
				fauxAssistantMessage("finished"),
			]);
			const keybindings = new KeybindingsManager();
			setKeybindings(keybindings);
			const editor = new CustomEditor(new TuiMainScreen(new RecordingTerminal()), getEditorTheme(), keybindings);
			const submit = async (typed: string, send: () => Promise<void>) => {
				editor.addToHistory(typed);
				await send();
			};
			await submit(`idle token ${secret}`, () => harness.session.prompt(`idle token ${secret}`));
			await submit(`/fixbug token ${secret}`, () => harness.session.prompt(`/fixbug token ${secret}`));
			const turn = harness.session.prompt("hold the turn");
			editor.addToHistory("hold the turn");
			await entered.promise;
			await submit(`steer token ${secret}`, () =>
				harness.session.prompt(`steer token ${secret}`, { streamingBehavior: "steer" }),
			);
			await submit(`follow token ${secret}`, () => harness.session.followUp(`follow token ${secret}`));
			await submit(`/fixbug queued token ${secret}`, () =>
				harness.session.followUp(`/fixbug queued token ${secret}`),
			);
			release.resolve();
			await turn;
			harness.session.pauseQueuedMessages();
			await submit(`paused token ${secret}`, () =>
				harness.session.prompt(`paused token ${secret}`, { streamingBehavior: "followUp" }),
			);
			await harness.session.resumeQueuedMessages();
			await submit("after the pause", () => harness.session.prompt("after the pause"));

			const entries = harness.session.sessionManager.getEntries();
			const userEntries = entries.filter((entry) => entry.type === "message" && entry.message.role === "user");
			assert.equal(userEntries.length, 8);
			assert.equal(hookInputs.filter((text) => text === `paused token ${secret}`).length, 1);
			for (const entry of userEntries) assert.ok(!JSON.stringify(entry).includes(secret), JSON.stringify(entry));

			const sessionPrompts = sessionPromptsFromEntries(entries);
			assert.deepEqual(
				sessionPrompts.map((entry) => entry.text).sort(),
				[
					"idle token [redacted]",
					"/fixbug token [redacted]",
					"hold the turn",
					"steer token [redacted]",
					"follow token [redacted]",
					"/fixbug queued token [redacted]",
					"after the pause",
					"paused token [redacted]",
				].sort(),
			);
			assert.ok(editor.getHistory().includes(`idle token ${secret}`), "up and down keep the typed prompts");

			let shown: Component | undefined;
			const mode = Object.assign(Object.create(InteractiveMode.prototype), {
				editor,
				runtimeHost: { session: harness.session },
				ui: { requestRender: () => {} },
				showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
					shown = create(() => {}).component;
				},
			}) as InteractiveMode;
			mode.showPromptHistorySearch();
			assert.ok(shown);
			const rendered = lines(shown, 120);
			assert.ok(!rendered.some((line) => line.includes(secret)), rendered.join("\n"));
			for (const text of ["idle token [redacted]", "/fixbug queued token [redacted]", "paused token [redacted]"])
				assert.ok(
					rendered.some((line) => line.includes(text)),
					`${text} missing:\n${rendered.join("\n")}`,
				);
		} finally {
			release.resolve();
			await harness.cleanup();
		}
	});
});
