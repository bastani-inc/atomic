import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeAll, describe, test } from "vitest";
import { getBuiltinPackageLocations } from "../../packages/coding-agent/src/core/builtin-packages.js";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { loadExtensionFromFactory, loadExtensions } from "../../packages/coding-agent/src/core/extensions/loader.js";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader-runtime.js";
import type { ExtensionAPI, MessageRenderer } from "../../packages/coding-agent/src/core/extensions/types.js";
import { createCustomMessage } from "../../packages/coding-agent/src/core/messages.js";
import { CustomMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/custom-message.js";
import { keyHint, keyText } from "../../packages/coding-agent/src/modes/interactive/components/keybinding-hints.js";
import {
	clickedBlocks,
	toggleClickedBlocks,
} from "../../packages/coding-agent/src/modes/interactive/components/transcript-block-clicks.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import webAccessLightFactory from "../../packages/web-access/index.js";
import webAccessHeavyFactory from "../../packages/web-access/index-heavy.js";

const tempDirs: string[] = [];

beforeAll(() => {
	initTheme("dark", false);
});

afterEach(() => {
	delete process.env.NO_COLOR;
	initTheme("dark", false);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function plain(lines: readonly string[]): string[] {
	return lines.map((line) => stripVTControlCharacters(line));
}

function assertClickMatchesCtrlO(component: CustomMessageComponent, width = 100): void {
	const collapsed = component.render(width);
	component.setExpanded(true);
	const expanded = component.render(width);
	component.setExpanded(false);
	const ctrlOChanges = collapsed.length !== expanded.length || collapsed.some((line, i) => line !== expanded[i]);

	const area = component.clickArea(width);
	assert.ok(area && area.end > area.start, "visible custom message must have non-empty clickArea");
	const unit = clickedBlocks([component], 0, width, area.start)!;
	let toggled: boolean | undefined;
	toggleClickedBlocks(unit, width, (next) => {
		toggled = next;
	});
	if (ctrlOChanges) {
		assert.equal(toggled, true, "click must expand when Ctrl+O changes rendered rows");
		assert.deepEqual(component.render(width), expanded);
		const expandedArea = component.clickArea(width)!;
		const collapseUnit = clickedBlocks([component], 0, width, expandedArea.end - 1)!;
		toggleClickedBlocks(collapseUnit, width, (next) => {
			toggled = next;
		});
		assert.equal(toggled, false, "second click must collapse back");
		assert.deepEqual(component.render(width), collapsed);
	} else {
		assert.equal(toggled, undefined, "click must stay no-op when Ctrl+O does not change rendered rows");
		assert.equal(component.isExpanded(), false);
	}
}

describe("core coding-agent owned custom messages never fall back to bracketed labels", () => {
	const coreCases = [
		{
			customType: "session-recovery-notice",
			content:
				"Session recovery after restart:\n- Restored 2 background subagents\n- Reattached Intercom group default",
			details: {
				reason: "resume",
				notices: ["Restored 2 background subagents", "Reattached Intercom group default"],
			},
			expectCollapsed: "Session recovery",
			expectExpanded: "Reattached Intercom group default",
		},
		{
			customType: "session-recovery-replay",
			content: "Replaying 2 interrupted deliveries from before the restart.",
			details: { reason: "resume", entryIds: ["entry-1111aaaa", "entry-2222bbbb"] },
			expectCollapsed: "Replaying 2 interrupted deliveries",
			expectExpanded: "entry-1111aaaa",
		},
		{
			customType: "event_report",
			content: 'Report from event child "ci#1/build-42" (event build-42):\n\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5',
			details: { subscriptionId: "sess-1/ci#1", eventId: "build-42", child: "ci#1/build-42" },
			expectCollapsed: "ci#1/build-42",
			expectExpanded: "Line 5",
		},
		{
			customType: "atomic.oversized-history-entry",
			content:
				"Saved entry 42 is 2097152 bytes. Read the original bytes with the session history reader or export this session.",
			details: undefined,
			expectCollapsed: "2.0 MB",
			expectExpanded: "2097152 bytes",
		},
	] as const;

	for (const tc of coreCases) {
		test(`${tc.customType} renders as notice card, expands via Ctrl+O & click, and fits narrow/wide widths`, () => {
			const msg = createCustomMessage(tc.customType, tc.content, true, tc.details, new Date(0).toISOString());
			const comp = new CustomMessageComponent(msg);

			assert.equal(comp.historyReplayable, true);
			const collapsedPlain = plain(comp.render(120)).join("\n");
			assert.ok(!collapsedPlain.includes(`[${tc.customType}]`), `must not render bracketed [${tc.customType}]`);
			assert.ok(
				collapsedPlain.includes(tc.expectCollapsed),
				`expected "${tc.expectCollapsed}" in:\n${collapsedPlain}`,
			);

			assertClickMatchesCtrlO(comp, 100);

			comp.setExpanded(true);
			const expandedPlain = plain(comp.render(120)).join("\n");
			assert.ok(expandedPlain.includes(tc.expectExpanded), `expected "${tc.expectExpanded}" in:\n${expandedPlain}`);

			for (const w of [1, 20, 40, 80, 120]) {
				for (const exp of [false, true]) {
					comp.setExpanded(exp);
					for (const row of comp.render(w)) {
						assert.ok(visibleWidth(row) <= w, `${tc.customType} overflowed width ${w}`);
					}
				}
			}

			process.env.NO_COLOR = "1";
			comp.setExpanded(false);
			for (const row of comp.render(100)) {
				assert.equal(row, stripVTControlCharacters(row));
			}
		});
	}

	test("third-party unknown customType preserves default bracketed fallback (no regression)", () => {
		const msg = createCustomMessage(
			"third-party-status",
			"Everything fine",
			true,
			undefined,
			new Date(0).toISOString(),
		);
		const comp = new CustomMessageComponent(msg);
		const text = plain(comp.render(80)).join("\n");
		assert.ok(text.includes("[third-party-status]"));
		assert.ok(text.includes("Everything fine"));
	});
});

describe("web-access owned custom messages register across dormant, light, and heavy paths", () => {
	const webTypes = [
		"curator-config",
		"google-account",
		"web-search-results",
		"web-search-content-ready",
		"web-search-error",
	] as const;

	async function loadWebRenderers() {
		const dir = mkdtempSync(join(tmpdir(), "atomic-web-msg-renderers-"));
		tempDirs.push(dir);
		const fakeHome = join(dir, "home");
		mkdirSync(fakeHome, { recursive: true });
		const webLoc = getBuiltinPackageLocations(true).find((loc) => loc.distDirName === "web-access");
		assert.ok(webLoc);
		const entryPath = join(webLoc.packageDir, "index.ts");

		const lazyLoaded = await loadExtensions([entryPath], dir);
		assert.deepEqual(lazyLoaded.errors, []);
		const lightExt = await loadExtensionFromFactory(
			webAccessLightFactory,
			dir,
			createEventBus(),
			createExtensionRuntime(),
			entryPath,
		);

		const heavyRenderers = new Map<string, MessageRenderer>();
		const basePi = {
			on: () => {},
			registerTool: () => {},
			registerCommand: () => {},
			registerShortcut: () => {},
			registerFlag: () => {},
			getFlag: () => undefined,
			registerMessageRenderer: (customType: string, renderer: MessageRenderer) => {
				heavyRenderers.set(customType, renderer);
			},
			registerEntryRenderer: () => {},
			registerToolRenderer: () => {},
			sendMessage: () => {},
			sendMessages: () => {},
			sendUserMessage: () => {},
			appendEntry: async () => {},
			setSessionName: async () => {},
			getSessionName: () => undefined,
			setLabel: async () => {},
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: () => {},
			getCommands: () => [],
			getThinkingLevel: () => "off",
			setThinkingLevel: () => {},
			registerProvider: () => {},
			unregisterProvider: () => {},
			events: { on: () => () => {}, emit: () => {} },
		} as unknown as ExtensionAPI;
		await webAccessHeavyFactory(basePi);

		return {
			dormant: lazyLoaded.extensions[0]!.messageRenderers,
			light: lightExt.messageRenderers,
			heavy: heavyRenderers,
		};
	}

	test("all 5 web-access customTypes render identically across dormant, light, and heavy paths without bracketed labels", async () => {
		const { dormant, light, heavy } = await loadWebRenderers();
		const samples = [
			createCustomMessage(
				"curator-config",
				[
					{
						type: "text",
						text: "Curator enabled — web_search will open curator and auto-generate a summary draft",
					},
				],
				true,
				{ workflow: "summary-review" },
				new Date(0).toISOString(),
			),
			createCustomMessage(
				"google-account",
				[
					{
						type: "text",
						text: "Gemini Web is unavailable. Sign into gemini.google.com in a supported Chromium-based browser.",
					},
				],
				true,
				{ available: false, cookieAccessAllowed: true },
				new Date(0).toISOString(),
			),
			createCustomMessage(
				"web-search-results",
				[{ type: "text", text: "Result line 1\nResult line 2\nResult line 3\nResult line 4\nResult line 5" }],
				true,
				{ curated: true, queryCount: 2, totalResults: 8, queries: ["atomic tui", "catppuccin"] },
				new Date(0).toISOString(),
			),
			createCustomMessage(
				"web-search-content-ready",
				"Content fetched for 3/4 URLs [fetch-1234abcd]. Full page content now available.",
				true,
				undefined,
				new Date(0).toISOString(),
			),
			createCustomMessage(
				"web-search-error",
				"Content fetch failed [fetch-1234abcd]: ECONNRESET while fetching remote host",
				true,
				undefined,
				new Date(0).toISOString(),
			),
		];

		for (const customType of webTypes) {
			assert.ok(dormant.has(customType), `dormant lazy-builtins/web-access must register ${customType}`);
			assert.ok(light.has(customType), `light web-access/index.ts must register ${customType}`);
			assert.ok(heavy.has(customType), `heavy web-access/index-heavy.ts must register ${customType}`);
		}

		for (const msg of samples) {
			const rDormant = dormant.get(msg.customType)!;
			const rLight = light.get(msg.customType)!;
			const rHeavy = heavy.get(msg.customType)!;

			for (const expanded of [false, true]) {
				const opts = { expanded, outputPad: 1, keyText, keyHint };
				const outDormant = rDormant(msg, opts, theme)?.render(100);
				const outLight = rLight(msg, opts, theme)?.render(100);
				const outHeavy = rHeavy(msg, opts, theme)?.render(100);
				assert.ok(outDormant && outDormant.length > 0);
				assert.deepEqual(outDormant, outLight, `${msg.customType} dormant vs light mismatch`);
				assert.deepEqual(outLight, outHeavy, `${msg.customType} light vs heavy mismatch`);
				assert.ok(!plain(outLight!).join("\n").includes(`[${msg.customType}]`));
			}

			const comp = new CustomMessageComponent(msg, rLight);
			assert.equal(comp.historyReplayable, true, `${msg.customType} must be historyReplayable`);
			assertClickMatchesCtrlO(comp, 100);
		}
	});
});
