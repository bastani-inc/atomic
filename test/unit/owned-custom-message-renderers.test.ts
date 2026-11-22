import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Text, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeAll, describe, test } from "vitest";
import {
	getBuiltinPackageLocations,
	getBuiltinPackagePaths,
	getMandatoryBuiltinExtensionPaths,
} from "../../packages/coding-agent/src/core/builtin-packages.js";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { createLazyBuiltinFactory } from "../../packages/coding-agent/src/core/extensions/lazy-builtin.js";
import { intercomLazyBuiltinSpec } from "../../packages/coding-agent/src/core/extensions/lazy-builtins/intercom.js";
import { webAccessLazyBuiltinSpec } from "../../packages/coding-agent/src/core/extensions/lazy-builtins/web-access.js";
import { loadExtensionFromFactory, loadExtensions } from "../../packages/coding-agent/src/core/extensions/loader.js";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader-runtime.js";
import { ExtensionRunner } from "../../packages/coding-agent/src/core/extensions/runner.js";
import type { ExtensionAPI, MessageRenderer } from "../../packages/coding-agent/src/core/extensions/types.js";
import { createCustomMessage } from "../../packages/coding-agent/src/core/messages.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
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

function normalizedText(lines: readonly string[]): string {
	return plain(lines)
		.map((l) => l.replace(/^\s*(?:⎿\s+)?/, "").trim())
		.filter(Boolean)
		.join(" ")
		.replace(/\s+/g, " ");
}

function unbrokenText(lines: readonly string[]): string {
	return plain(lines)
		.map((l) => l.replace(/^\s*(?:⎿\s+)?/, "").trim())
		.filter(Boolean)
		.join("");
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
			expectExpanded: ["Restored 2 background subagents", "Reattached Intercom group default"],
		},
		{
			customType: "session-recovery-replay",
			content: "Replaying 2 interrupted deliveries from before the restart.",
			details: { reason: "resume", entryIds: ["entry-1111aaaa", "entry-2222bbbb"] },
			expectCollapsed: "Replaying 2 interrupted deliveries",
			expectExpanded: ["entry-1111aaaa", "entry-2222bbbb", "from before the restart."],
		},
		{
			customType: "event_report",
			content: 'Report from event child "ci#1/build-42" (event build-42):\n\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5',
			details: { subscriptionId: "sess-1/ci#1", eventId: "build-42", child: "ci#1/build-42" },
			expectCollapsed: "ci#1/build-42",
			expectExpanded: ["Line 5", "Child · ci#1/build-42", "Subscription · sess-1/ci#1"],
		},
		{
			customType: "atomic.oversized-history-entry",
			content:
				"Saved entry 42 is 2097152 bytes. Read the original bytes with the session history reader or export this session.",
			details: undefined,
			expectCollapsed: "2.0 MB",
			expectExpanded: ["Saved entry 42 is 2097152 bytes.", "session history reader or export this session."],
		},
	] as const;

	for (const tc of coreCases) {
		test(`${tc.customType} renders as notice card, expands losslessly at 80 and 120 cols via Ctrl+O & click`, () => {
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

			for (const w of [80, 120]) {
				comp.setExpanded(true);
				const rows = comp.render(w);
				for (const row of rows) {
					assert.ok(visibleWidth(row) <= w, `${tc.customType} overflowed width ${w}`);
				}
				const joined = normalizedText(rows);
				for (const expected of tc.expectExpanded) {
					assert.ok(joined.includes(expected), `${tc.customType} w=${w} lost "${expected}" in:\n${joined}`);
				}
			}

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

	test("long and multi-line core messages wrap losslessly at 80 and 120 cols without popping collapsed summaries to blank", () => {
		// 1. Single long multi-line recovery notice (> 80 chars)
		const longNotice =
			"Closed 25 answered subagent asks after restart and reconciled pending deliveries across sessions.\nSecond line of recovery detail preserved intact.";
		const recMsg = createCustomMessage(
			"session-recovery-notice",
			`Session recovery after restart:\n- ${longNotice}`,
			true,
			{ reason: "resume", notices: [longNotice] },
			new Date(0).toISOString(),
		);
		const recComp = new CustomMessageComponent(recMsg);
		const recCollapsed80 = plain(recComp.render(80))[1]!;
		assert.ok(
			recCollapsed80.includes("Session recovery · Closed 25"),
			`80-col collapsed single recovery notice must not pop meta to blank, got: ${recCollapsed80}`,
		);
		for (const w of [80, 120]) {
			recComp.setExpanded(true);
			const rows = recComp.render(w);
			for (const row of rows) assert.ok(visibleWidth(row) <= w);
			const joined = normalizedText(rows);
			assert.ok(joined.includes("reconciled pending deliveries across sessions."));
			assert.ok(joined.includes("Second line of recovery detail preserved intact."));
		}

		// 2. File-archive oversized entry emitter ("Saved file entry at byte N is M bytes...")
		const fileOversized =
			"Saved file entry at byte 42 is 2097152 bytes. Read the original bytes with the session history reader or export this session.";
		const fileComp = new CustomMessageComponent(
			createCustomMessage(
				"atomic.oversized-history-entry",
				fileOversized,
				true,
				undefined,
				new Date(0).toISOString(),
			),
		);
		const fileCollapsed80 = plain(fileComp.render(80))[1]!;
		assert.ok(fileCollapsed80.includes("byte 42"), `expected byte offset in collapsed line, got: ${fileCollapsed80}`);
		assert.ok(fileCollapsed80.includes("2.0 MB"));
		for (const w of [80, 120]) {
			fileComp.setExpanded(true);
			const rows = fileComp.render(w);
			for (const row of rows) assert.ok(visibleWidth(row) <= w);
			assert.ok(normalizedText(rows).includes(fileOversized), `w=${w} lost file oversized text`);
		}

		// 3. Event report with very long child name that truncates in header at 80 cols
		const longChild = "deployment-pipeline-monitor-production-us-east-1#42/build-event-2026-11-22-final";
		const evComp = new CustomMessageComponent(
			createCustomMessage(
				"event_report",
				`Report from event child "${longChild}" (event evt-long-id-12345678901234567890):\n\nAll checks succeeded.`,
				true,
				{
					subscriptionId: "session-abc/deployment-pipeline#42",
					eventId: "evt-long-id-12345678901234567890",
					child: longChild,
				},
				new Date(0).toISOString(),
			),
		);
		for (const w of [80, 120]) {
			evComp.setExpanded(true);
			const rows = evComp.render(w);
			for (const row of rows) assert.ok(visibleWidth(row) <= w);
			const joined = normalizedText(rows);
			const unbroken = unbrokenText(rows);
			assert.ok(unbroken.includes(longChild), `w=${w} lost full event child name in:\n${plain(rows).join("\n")}`);
			assert.ok(joined.includes("evt-long-id-12345678901234567890"), `w=${w} lost full eventId`);
			assert.ok(joined.includes("session-abc/deployment-pipeline#42"), `w=${w} lost subscriptionId`);
		}
	});

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

	test("all 5 web-access customTypes render identically across dormant, light, and heavy paths and expand losslessly at 80 and 120 cols", async () => {
		const { dormant, light, heavy } = await loadWebRenderers();
		const cookieDisabledText =
			"Gemini Web browser cookie access is disabled. Set allowBrowserCookies: true in ~/.atomic/web-search.json to enable it.";
		const multiLineError =
			"Content fetch failed [fetch-1234abcd]: ECONNRESET while fetching https://example.com/very/long/path/document.html\nRetry after checking proxy configuration and TLS certificates.";
		const samples = [
			{
				msg: createCustomMessage(
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
				expectExpanded: ["auto-generate a summary draft"],
			},
			{
				msg: createCustomMessage(
					"google-account",
					[{ type: "text", text: cookieDisabledText }],
					true,
					{ available: false, cookieAccessAllowed: false },
					new Date(0).toISOString(),
				),
				expectExpanded: ["allowBrowserCookies: true in ~/.atomic/web-search.json to enable it."],
			},
			{
				msg: createCustomMessage(
					"web-search-results",
					[{ type: "text", text: "Result line 1\nResult line 2\nResult line 3\nResult line 4\nResult line 5" }],
					true,
					{ curated: true, queryCount: 2, totalResults: 8, queries: ["atomic tui", "catppuccin"] },
					new Date(0).toISOString(),
				),
				expectExpanded: ["Result line 5"],
			},
			{
				msg: createCustomMessage(
					"web-search-content-ready",
					"Content fetched for 3/4 URLs [fetch-1234abcd]. Full page content now available.",
					true,
					undefined,
					new Date(0).toISOString(),
				),
				expectExpanded: ["fetch-1234abcd", "Full page content now available."],
			},
			{
				msg: createCustomMessage("web-search-error", multiLineError, true, undefined, new Date(0).toISOString()),
				expectExpanded: [
					"fetch-1234abcd",
					"https://example.com/very/long/path/document.html",
					"Retry after checking proxy configuration and TLS certificates.",
				],
			},
		];

		for (const customType of webTypes) {
			assert.ok(dormant.has(customType), `dormant lazy-builtins/web-access must register ${customType}`);
			assert.ok(light.has(customType), `light web-access/index.ts must register ${customType}`);
			assert.ok(heavy.has(customType), `heavy web-access/index-heavy.ts must register ${customType}`);
		}

		for (const { msg, expectExpanded } of samples) {
			const rDormant = dormant.get(msg.customType)!;
			const rLight = light.get(msg.customType)!;
			const rHeavy = heavy.get(msg.customType)!;

			for (const width of [80, 120]) {
				for (const expanded of [false, true]) {
					const opts = { expanded, outputPad: 1, keyText, keyHint };
					const outDormant = rDormant(msg, opts, theme)?.render(width);
					const outLight = rLight(msg, opts, theme)?.render(width);
					const outHeavy = rHeavy(msg, opts, theme)?.render(width);
					assert.ok(outDormant && outDormant.length > 0);
					assert.deepEqual(outDormant, outLight, `${msg.customType} dormant vs light mismatch (w=${width})`);
					assert.deepEqual(outLight, outHeavy, `${msg.customType} light vs heavy mismatch (w=${width})`);
					assert.ok(!plain(outLight!).join("\n").includes(`[${msg.customType}]`));
					for (const row of outLight!) {
						assert.ok(visibleWidth(row) <= width, `${msg.customType} overflowed width ${width}`);
					}
					if (expanded) {
						const joined = normalizedText(outLight!);
						for (const snippet of expectExpanded) {
							assert.ok(
								joined.includes(snippet),
								`${msg.customType} w=${width} lost "${snippet}" in:\n${joined}`,
							);
						}
					}
				}
			}

			const comp = new CustomMessageComponent(msg, rLight);
			assert.equal(comp.historyReplayable, true, `${msg.customType} must be historyReplayable`);
			assertClickMatchesCtrlO(comp, 80);
		}
	});
});

describe("resumed sessions keep intercom and web-access dormant for new custom_message types", () => {
	test("session_start with intercom_subagent_wake keeps Intercom dormant while rendering the wake card", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-dormant-wake-resume-"));
		tempDirs.push(dir);
		let loadCount = 0;
		const factory = createLazyBuiltinFactory(intercomLazyBuiltinSpec, async () => {
			loadCount += 1;
			return () => {};
		});
		const bus = createEventBus();
		const runtime = createExtensionRuntime();
		const ext = await loadExtensionFromFactory(factory, dir, bus, runtime, "builtin:intercom");
		const manager = SessionManager.inMemory(dir);
		await manager.appendCustomMessageEntry(
			"intercom_subagent_wake",
			"Resuming subagent `subagent-debugger-45255a2f-7` (45255a2f:6) for an Intercom message from subagent-worker-45255a2f-3. It stays this session's subagent: its result arrives here.",
			true,
			{
				childName: "subagent-debugger-45255a2f-7",
				childId: "45255a2f:6",
				from: { id: "133acdf4-dc40-4f80-865c-ba1931d0a8cc", name: "subagent-worker-45255a2f-3" },
				depth: 1,
			},
		);
		const modelRegistry = new ModelRegistry(await ModelRuntime.create({ modelsPath: null }));
		const runner = new ExtensionRunner([ext], runtime, dir, manager, modelRegistry);
		await runner.emit({ type: "session_start", reason: "resume" });
		assert.equal(
			loadCount,
			0,
			"resuming a session with only intercom_subagent_wake must not eagerly activate Intercom",
		);

		const renderer = runner.getMessageRenderer("intercom_subagent_wake");
		assert.ok(renderer, "dormant wake renderer must be registered");
		const rendered = plain(
			renderer(
				createCustomMessage(
					"intercom_subagent_wake",
					"Resuming subagent `subagent-debugger-45255a2f-7` (45255a2f:6) for an Intercom message from subagent-worker-45255a2f-3. It stays this session's subagent: its result arrives here.",
					true,
					{
						childName: "subagent-debugger-45255a2f-7",
						childId: "45255a2f:6",
						from: { id: "133acdf4-dc40-4f80-865c-ba1931d0a8cc", name: "subagent-worker-45255a2f-3" },
						depth: 1,
					},
					new Date(0).toISOString(),
				),
				{ expanded: false, outputPad: 1, keyText, keyHint },
				theme,
			)!.render(120),
		).join("\n");
		assert.ok(rendered.includes("Woke subagent-debugger-…-7 for a message from subagent-worker-…-3"));
		assert.equal(loadCount, 0, "rendering the wake card must stay dormant");
	});

	test("session_start with all 5 web-access custom_message types keeps Web Access dormant while rendering each card", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-dormant-web-resume-"));
		tempDirs.push(dir);
		let loadCount = 0;
		const factory = createLazyBuiltinFactory(webAccessLazyBuiltinSpec, async () => {
			loadCount += 1;
			return () => {};
		});
		const bus = createEventBus();
		const runtime = createExtensionRuntime();
		const ext = await loadExtensionFromFactory(factory, dir, bus, runtime, "builtin:web-access");
		const manager = SessionManager.inMemory(dir);
		for (const customType of [
			"curator-config",
			"google-account",
			"web-search-results",
			"web-search-content-ready",
			"web-search-error",
		]) {
			await manager.appendCustomMessageEntry(customType, `saved ${customType}`, true, {});
		}
		const modelRegistry = new ModelRegistry(await ModelRuntime.create({ modelsPath: null }));
		const runner = new ExtensionRunner([ext], runtime, dir, manager, modelRegistry);
		await runner.emit({ type: "session_start", reason: "resume" });
		assert.equal(
			loadCount,
			0,
			"resuming a session with web-access custom messages must not eagerly activate Web Access",
		);

		for (const customType of [
			"curator-config",
			"google-account",
			"web-search-results",
			"web-search-content-ready",
			"web-search-error",
		]) {
			const renderer = runner.getMessageRenderer(customType);
			assert.ok(renderer, `dormant renderer for ${customType} must be registered`);
			const out = plain(
				renderer(
					createCustomMessage(customType, `saved ${customType}`, true, {}, new Date(0).toISOString()),
					{ expanded: false, outputPad: 1, keyText, keyHint },
					theme,
				)!.render(100),
			).join("\n");
			assert.ok(!out.includes(`[${customType}]`));
		}
		assert.equal(loadCount, 0, "rendering web-access custom messages must stay dormant");
	});
});

describe("extension message renderer precedence over builtin notice cards", () => {
	const ALL_TEN_TYPES = [
		"intercom_subagent_wake",
		"session-recovery-notice",
		"session-recovery-replay",
		"event_report",
		"atomic.oversized-history-entry",
		"curator-config",
		"google-account",
		"web-search-results",
		"web-search-content-ready",
		"web-search-error",
	] as const;

	function writeOverrideExtensionFile(filePath: string, marker: string): void {
		const typesJson = JSON.stringify(ALL_TEN_TYPES);
		writeFileSync(
			filePath,
			`export default function (pi) {
	for (const customType of ${typesJson}) {
		pi.registerMessageRenderer(customType, () => ({
			invalidate() {},
			render() { return ["${marker}:" + customType]; },
		}));
	}
}
`,
		);
	}

	async function assertAllTenWin(loader: DefaultResourceLoader, marker: string): Promise<void> {
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		const modelRegistry = new ModelRegistry(await ModelRuntime.create({ modelsPath: null }));
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			process.cwd(),
			SessionManager.inMemory(process.cwd()),
			modelRegistry,
		);
		for (const customType of ALL_TEN_TYPES) {
			const msg = createCustomMessage(customType, "body", true, {}, new Date(0).toISOString());
			const comp = new CustomMessageComponent(msg, runner.getMessageRenderer(customType));
			const rendered = plain(comp.render(100)).join("\n");
			assert.ok(
				rendered.includes(`${marker}:${customType}`),
				`expected ${marker} override to win for ${customType}, got:\n${rendered}`,
			);
		}
	}

	test("inline SDK extensionFactories override wins over builtinPackagePaths for all 10 types", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-precedence-inline-"));
		tempDirs.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			builtinPackagePaths: getBuiltinPackagePaths(),
			extensionFactories: [
				(pi) => {
					for (const customType of ALL_TEN_TYPES) {
						pi.registerMessageRenderer(customType, () => new Text(`INLINE:${customType}`, 0, 0));
					}
				},
			],
		});
		await assertAllTenWin(loader, "INLINE");
	});

	test("CLI -e additionalExtensionPaths override wins over builtinPackagePaths for all 10 types", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-precedence-cli-"));
		tempDirs.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const extFile = join(root, "cli-override.mjs");
		writeOverrideExtensionFile(extFile, "CLI");

		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			builtinPackagePaths: getBuiltinPackagePaths(),
			additionalExtensionPaths: [extFile],
		});
		await assertAllTenWin(loader, "CLI");
	});

	test("project .atomic/extensions override wins over builtinPackagePaths for all 10 types", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-precedence-project-"));
		tempDirs.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const projectExtDir = join(cwd, ".atomic", "extensions");
		mkdirSync(projectExtDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeOverrideExtensionFile(join(projectExtDir, "project-override.js"), "PROJECT");

		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			builtinPackagePaths: getBuiltinPackagePaths(),
		});
		await assertAllTenWin(loader, "PROJECT");
	});

	test("installed package extension override wins over builtinPackagePaths for all 10 types", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-precedence-pkg-"));
		tempDirs.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const pkgDir = join(root, "my-ext-pkg");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(pkgDir, { recursive: true });
		writeOverrideExtensionFile(join(pkgDir, "index.mjs"), "PACKAGE");
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ name: "my-ext-pkg", version: "1.0.0", atomic: { extensions: ["./index.mjs"] } }),
		);

		const settingsManager = SettingsManager.inMemory({ packages: [pkgDir] });
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			builtinPackagePaths: getBuiltinPackagePaths(),
		});
		await assertAllTenWin(loader, "PACKAGE");
	});

	test("mandatory intercom entry path stays valid when loaded standalone", () => {
		const [intercomEntry] = getMandatoryBuiltinExtensionPaths();
		assert.ok(intercomEntry);
	});

	test("7-source x 14-type message renderer precedence matrix matches main cell for cell", async () => {
		const PREEXISTING_BUILTINS = [
			"intercom_message",
			"subagent-slash-result",
			"subagent-notify",
			"subagent-late-tool-result",
			"subagent-resume-note",
			"subagent_control_notice",
		] as const;
		const NEW_BUILTINS = [
			"intercom_subagent_wake",
			"curator-config",
			"google-account",
			"web-search-results",
			"web-search-content-ready",
			"web-search-error",
		] as const;
		const MATRIX_TYPES = [
			...PREEXISTING_BUILTINS,
			...NEW_BUILTINS,
			"session-recovery-notice",
			"third-party-custom",
		] as const;

		const writeMatrixExt = (filePath: string, marker: string) => {
			writeFileSync(
				filePath,
				`export default function (pi) {
	for (const customType of ${JSON.stringify(MATRIX_TYPES)}) {
		pi.registerMessageRenderer(customType, () => ({
			invalidate() {},
			render() { return ["${marker}:" + customType]; },
		}));
	}
}
`,
			);
		};

		const inlineFactory = (marker: string) => (pi: ExtensionAPI) => {
			for (const customType of MATRIX_TYPES) {
				pi.registerMessageRenderer(customType, () => new Text(`${marker}:${customType}`, 0, 0));
			}
		};

		const winnerOf = (runner: ExtensionRunner, customType: string): string => {
			const msg = createCustomMessage(customType, "body", true, {}, new Date(0).toISOString());
			const comp = new CustomMessageComponent(msg, runner.getMessageRenderer(customType));
			const text = plain(comp.render(100)).join(" ").trim();
			const match = /^([A-Z_]+):/.exec(text);
			return match ? match[1]! : "BUNDLED";
		};

		const checkRunner = (
			label: string,
			runner: ExtensionRunner,
			expected: Record<(typeof MATRIX_TYPES)[number], string>,
		) => {
			for (const customType of MATRIX_TYPES) {
				assert.equal(winnerOf(runner, customType), expected[customType], `${label} mismatch for ${customType}`);
			}
		};

		const all = (winner: string) =>
			Object.fromEntries(MATRIX_TYPES.map((t) => [t, winner])) as Record<(typeof MATRIX_TYPES)[number], string>;

		const loadAndBuildRunner = async (loader: DefaultResourceLoader) => {
			await loader.reload();
			const loaded = loader.getExtensions();
			assert.deepEqual(loaded.errors, []);
			return new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				process.cwd(),
				SessionManager.inMemory(process.cwd()),
				new ModelRegistry(await ModelRuntime.create({ modelsPath: null })),
			);
		};

		// 1. Inline + DefaultResourceLoader(builtinPackagePaths): pre-existing 6 keep BUNDLED, new 6 + core + custom -> INLINE
		{
			const root = mkdtempSync(join(tmpdir(), "atomic-matrix-1-"));
			tempDirs.push(root);
			const cwd = join(root, "proj");
			const agentDir = join(root, "agent");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			const runner = await loadAndBuildRunner(
				new DefaultResourceLoader({
					cwd,
					agentDir,
					settingsManager: SettingsManager.inMemory(),
					builtinPackagePaths: getBuiltinPackagePaths(),
					extensionFactories: [inlineFactory("INLINE")],
				}),
			);
			checkRunner("1. Inline + DefaultResourceLoader(builtinPackagePaths)", runner, {
				...all("INLINE"),
				...Object.fromEntries(PREEXISTING_BUILTINS.map((t) => [t, "BUNDLED"])),
			});
		}

		// 2. Inline + createAgentSession (BuiltinResourceLoader): ALL 14 -> INLINE
		{
			const root = mkdtempSync(join(tmpdir(), "atomic-matrix-2-"));
			tempDirs.push(root);
			const cwd = join(root, "proj");
			const agentDir = join(root, "agent");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				extensionFactories: [inlineFactory("INLINE")],
			});
			await resourceLoader.reload();
			const created = await createAgentSession({
				cwd,
				agentDir,
				sessionManager: SessionManager.inMemory(cwd),
				settingsManager,
				resourceLoader,
			});
			try {
				checkRunner("2. Inline + createAgentSession", created.session.extensionRunner, all("INLINE"));
			} finally {
				await created.session.dispose();
			}
		}

		// 6. Inherited-pi project (.pi/extensions) + user (~/.atomic/agent/extensions): ALL 14 -> INHERITED_PI_PROJ
		{
			const root = mkdtempSync(join(tmpdir(), "atomic-matrix-6-"));
			tempDirs.push(root);
			const cwd = join(root, "proj");
			const agentDir = join(root, "agent");
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			mkdirSync(join(agentDir, "extensions"), { recursive: true });
			writeMatrixExt(join(cwd, ".pi", "extensions", "legacy.js"), "INHERITED_PI_PROJ");
			writeMatrixExt(join(agentDir, "extensions", "user.js"), "USER_ATOMIC");
			const runner = await loadAndBuildRunner(
				new DefaultResourceLoader({
					cwd,
					agentDir,
					settingsManager: SettingsManager.inMemory(),
					builtinPackagePaths: getBuiltinPackagePaths(),
				}),
			);
			checkRunner("6. Inherited-pi (.pi/extensions) + user (~/.atomic)", runner, all("INHERITED_PI_PROJ"));
		}

		// 7. Inherited-pi user (~/.pi/agent/extensions): ALL 14 -> INHERITED_PI_USER
		{
			const root = mkdtempSync(join(tmpdir(), "atomic-matrix-7-"));
			tempDirs.push(root);
			const fakeHome = join(root, "home");
			const cwd = join(root, "proj");
			const agentDir = join(fakeHome, ".atomic", "agent");
			const legacyPiExtDir = join(fakeHome, ".pi", "agent", "extensions");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(legacyPiExtDir, { recursive: true });
			writeMatrixExt(join(legacyPiExtDir, "legacy-user.js"), "INHERITED_PI_USER");
			const origHome = process.env.HOME;
			const origUserProfile = process.env.USERPROFILE;
			const origAtomicDir = process.env.ATOMIC_CODING_AGENT_DIR;
			const origPiDir = process.env.PI_CODING_AGENT_DIR;
			process.env.HOME = fakeHome;
			process.env.USERPROFILE = fakeHome;
			delete process.env.ATOMIC_CODING_AGENT_DIR;
			delete process.env.PI_CODING_AGENT_DIR;
			try {
				const runner = await loadAndBuildRunner(
					new DefaultResourceLoader({
						cwd,
						agentDir,
						settingsManager: SettingsManager.inMemory(),
						builtinPackagePaths: getBuiltinPackagePaths(),
					}),
				);
				checkRunner("7. Inherited-pi user (~/.pi/agent/extensions)", runner, all("INHERITED_PI_USER"));
			} finally {
				if (origHome === undefined) delete process.env.HOME;
				else process.env.HOME = origHome;
				if (origUserProfile === undefined) delete process.env.USERPROFILE;
				else process.env.USERPROFILE = origUserProfile;
				if (origAtomicDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
				else process.env.ATOMIC_CODING_AGENT_DIR = origAtomicDir;
				if (origPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = origPiDir;
			}
		}
	});

	test("in-process CustomMessageComponent refreshes when attachStartupExtensions or registerMessageRenderer fires on the same runner", async () => {
		const bus = createEventBus();
		const runtimeObj = createExtensionRuntime();
		const runner = new ExtensionRunner(
			[],
			runtimeObj,
			process.cwd(),
			SessionManager.inMemory(process.cwd()),
			new ModelRegistry(await ModelRuntime.create({ modelsPath: null })),
		);

		const msg = createCustomMessage(
			"curator-config",
			[{ type: "text", text: "Curator disabled — web_search will return raw results" }],
			true,
			{ workflow: "none" },
			new Date(0).toISOString(),
		);
		const comp = new CustomMessageComponent(msg, runner.getMessageRenderer(msg.customType));
		assert.ok(plain(comp.render(100)).join("\n").includes("[curator-config]"));

		let versionBumps = 0;
		const stop = runner.onRenderersChanged(() => {
			versionBumps += 1;
			comp.setCustomRenderer(runner.getMessageRenderer(msg.customType));
		});
		const v0 = runner.rendererVersion;
		let lateApi: ExtensionAPI | undefined;
		const ext = await loadExtensionFromFactory(
			(pi) => {
				lateApi = pi;
				pi.registerMessageRenderer("curator-config", () => new Text("ATTACHED_RENDERER", 0, 0));
			},
			process.cwd(),
			bus,
			runtimeObj,
			"inline:late",
		);
		const start = runner.attachStartupExtensions([ext]);
		await start();
		assert.ok(runner.rendererVersion > v0);
		assert.ok(versionBumps >= 1);
		assert.ok(plain(comp.render(100)).join("\n").includes("ATTACHED_RENDERER"));

		const v1 = runner.rendererVersion;
		lateApi!.registerMessageRenderer("curator-config", () => new Text("DYNAMIC_RENDERER", 0, 0));
		assert.ok(runner.rendererVersion > v1);
		assert.ok(plain(comp.render(100)).join("\n").includes("DYNAMIC_RENDERER"));
		stop();
	});
});
