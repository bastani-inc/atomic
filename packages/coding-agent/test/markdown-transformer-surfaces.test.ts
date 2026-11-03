import { Container } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type {
	Extension,
	MarkdownMessageType,
	MarkdownTransformContext,
	MarkdownTransformer,
} from "../src/core/extensions/types.ts";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const fixture = vi.hoisted(() => ({ changelogPath: "" }));

vi.mock("../src/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/config.js")>()),
	getChangelogPath: () => fixture.changelogPath,
}));

const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { collectMarkdownTransformers } = await import("../src/core/extensions/runner-registries.ts");
const { createCustomMessage } = await import("../src/core/messages.ts");
const { InMemorySettingsStorage, SettingsManager } = await import("../src/core/settings-manager.ts");
const { InteractiveMode } = await import("../src/modes/interactive/interactive-mode.ts");

const workDir = mkdtempSync(join(tmpdir(), "atomic-markdown-surfaces-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));
beforeAll(() => initTheme("dark"));

function render(component: { render(width: number): string[] }): string {
	return stripAnsi(component.render(80).join("\n"));
}

describe("Markdown transformers on message surfaces", () => {
	const seen: Array<{ markdown: string; context: MarkdownTransformContext }> = [];
	const transformers: MarkdownTransformer[] = [
		(markdown, context) => {
			seen.push({ markdown, context });
			return markdown.replace("details", "transformed");
		},
	];

	test("a default-rendered custom message runs transformers as custom with its entry identity", () => {
		seen.length = 0;
		const message = createCustomMessage("note", "details", true, undefined, "2025-01-15T10:30:00.000Z");
		const component = new CustomMessageComponent(
			message,
			undefined,
			undefined,
			1,
			true,
			transformers,
			"entry-1",
			"ts-1",
		);

		const rendered = render(component);

		expect(rendered).toContain("[note]");
		expect(rendered).toContain("transformed");
		expect(rendered).not.toContain("details");
		expect(seen[0]).toMatchObject({
			markdown: "details",
			context: { messageType: "custom", isStreaming: false, messageId: "entry-1", timestamp: "ts-1" },
		});
	});

	test("an expanded branch summary transforms the summary as summary, never Atomic's header", () => {
		seen.length = 0;
		const component = new BranchSummaryMessageComponent(
			{ role: "branchSummary", summary: "details", fromId: "entry-0", timestamp: Date.now() },
			undefined,
			true,
			1,
			transformers,
			"entry-1",
		);
		component.setExpanded(true);

		const rendered = render(component);

		expect(rendered).toContain("Branch Summary");
		expect(rendered).toContain("transformed");
		expect(rendered).not.toContain("details");
		expect(seen[0]).toMatchObject({ markdown: "details", context: { messageType: "summary", messageId: "entry-1" } });
	});

	test("an expanded skill block transforms its content as custom, never the skill header", () => {
		seen.length = 0;
		const component = new SkillInvocationMessageComponent(
			{ name: "example-skill", location: "/tmp/example-skill.md", content: "details", userMessage: undefined },
			undefined,
			true,
			1,
			transformers,
			"entry-1",
		);
		component.setExpanded(true);

		const rendered = render(component);

		expect(rendered).toContain("example-skill");
		expect(rendered).toContain("transformed");
		expect(rendered).not.toContain("details");
		expect(seen[0]).toMatchObject({ markdown: "details", context: { messageType: "custom", messageId: "entry-1" } });
	});

	test("collapsed summaries and skills do not run transformers", () => {
		seen.length = 0;
		const branch = new BranchSummaryMessageComponent(
			{ role: "branchSummary", summary: "details", fromId: "entry-0", timestamp: Date.now() },
			undefined,
			true,
			1,
			transformers,
		);
		const skill = new SkillInvocationMessageComponent(
			{ name: "example-skill", location: "/tmp/x.md", content: "details", userMessage: undefined },
			undefined,
			true,
			1,
			transformers,
		);

		render(branch);
		render(skill);

		expect(seen).toEqual([]);
	});

	test("components render unchanged when no transformers are given", () => {
		const component = new BranchSummaryMessageComponent(
			{ role: "branchSummary", summary: "details", fromId: "entry-0", timestamp: Date.now() },
			undefined,
			true,
			1,
		);
		component.setExpanded(true);

		expect(render(component)).toContain("details");
	});
});

describe("Markdown transformers on the changelog", () => {
	const replaceShortcodes: MarkdownTransformer = (markdown) => markdown.replaceAll(":warning:", "⚠");

	function extensionWith(
		transformer: MarkdownTransformer,
		messageTypes: readonly MarkdownMessageType[],
	): Pick<Extension, "markdownTransformer"> {
		return { markdownTransformer: { transformer, messageTypes: new Set(messageTypes) } };
	}

	function mode(extensions: Pick<Extension, "markdownTransformer">[]) {
		const host = {
			startupNoticesShown: false,
			startupNoticesPrepared: true,
			changelogMarkdown: "## [2.0.0]\n\n- :warning: Atomic change",
			firstRunNoticeVisible: false,
			version: "2.0.0",
			chatContainer: new Container(),
			ui: { requestRender: () => undefined },
			settingsManager: SettingsManager.fromStorage(new InMemorySettingsStorage()),
			mermaidMarkdownTransformer: (markdown: string) => markdown,
			mermaidMarkdownTransformerMode: "streaming",
			runtimeHost: {},
			session: {
				extensionRunner: { getMarkdownTransformers: () => collectMarkdownTransformers(extensions as Extension[]) },
			},
			getMarkdownThemeWithSettings: Reflect.get(InteractiveMode.prototype, "getMarkdownThemeWithSettings"),
			getMarkdownTransformers: Reflect.get(InteractiveMode.prototype, "getMarkdownTransformers"),
			createChangelogMarkdown: Reflect.get(InteractiveMode.prototype, "createChangelogMarkdown"),
		};
		return host;
	}

	function renderStartupNotice(extensions: Pick<Extension, "markdownTransformer">[]): string {
		const host = mode(extensions);
		host.settingsManager.setMermaidRenderingMode("streaming");
		const show = Reflect.get(InteractiveMode.prototype, "showStartupNoticesIfNeeded") as (this: typeof host) => void;
		show.call(host);
		return stripAnsi(host.chatContainer.render(100).join("\n"));
	}

	function renderChangelogCommand(extensions: Pick<Extension, "markdownTransformer">[]): string {
		fixture.changelogPath = join(workDir, "CHANGELOG.md");
		writeFileSync(
			fixture.changelogPath,
			"# Changelog\n\n## [2.0.0] - 2026-01-01\n\n### Fixed\n\n- :warning: Atomic fix\n",
		);
		const host = mode(extensions);
		const command = Reflect.get(InteractiveMode.prototype, "handleChangelogCommand") as (this: typeof host) => void;
		command.call(host);
		return stripAnsi(host.chatContainer.render(100).join("\n"));
	}

	test("a changelog transformer runs on What's New at startup", () => {
		const rendered = renderStartupNotice([extensionWith(replaceShortcodes, ["changelog"])]);

		expect(rendered).toContain("⚠ Atomic change");
		expect(rendered).not.toContain(":warning:");
	});

	test("a changelog transformer loaded after the startup notice redraws What's New without repeating it", () => {
		// Deferred startup shows What's New before extensions load, then shows startup notices again once they have.
		const extensions: Pick<Extension, "markdownTransformer">[] = [];
		const host = mode(extensions);
		host.settingsManager.setMermaidRenderingMode("streaming");
		const show = Reflect.get(InteractiveMode.prototype, "showStartupNoticesIfNeeded") as (this: typeof host) => void;
		show.call(host);
		expect(stripAnsi(host.chatContainer.render(100).join("\n"))).toContain(":warning: Atomic change");

		extensions.push(extensionWith(replaceShortcodes, ["changelog"]));
		show.call(host);
		const rendered = stripAnsi(host.chatContainer.render(100).join("\n"));

		expect(rendered).toContain("⚠ Atomic change");
		expect(rendered).not.toContain(":warning:");
		expect(rendered.match(/What's New/g)).toHaveLength(1);
	});

	test("a changelog transformer runs on /changelog", () => {
		const rendered = renderChangelogCommand([extensionWith(replaceShortcodes, ["changelog"])]);

		expect(rendered).toContain("⚠ Atomic fix");
		expect(rendered).not.toContain(":warning:");
	});

	test("a transformer registered for the default message types leaves the changelog unchanged", () => {
		const defaults: readonly MarkdownMessageType[] = ["user", "assistant", "assistant-thinking"];

		expect(renderStartupNotice([extensionWith(replaceShortcodes, defaults)])).toContain(":warning: Atomic change");
		expect(renderChangelogCommand([extensionWith(replaceShortcodes, defaults)])).toContain(":warning: Atomic fix");
	});
});
