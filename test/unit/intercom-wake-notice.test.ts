import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeAll, describe, test } from "vitest";
import { getMandatoryBuiltinExtensionPaths } from "../../packages/coding-agent/src/core/builtin-packages.js";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { loadExtensionFromFactory, loadExtensions } from "../../packages/coding-agent/src/core/extensions/loader.js";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader-runtime.js";
import type { ExtensionAPI, MessageRenderer } from "../../packages/coding-agent/src/core/extensions/types.js";
import { createCustomMessage } from "../../packages/coding-agent/src/core/messages.js";
import { CustomMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/custom-message.js";
import { keyHint, keyText } from "../../packages/coding-agent/src/modes/interactive/components/keybinding-hints.js";
import {
	clickedBlocks,
	isClickExpandableBlock,
	toggleClickedBlocks,
} from "../../packages/coding-agent/src/modes/interactive/components/transcript-block-clicks.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import intercomLightFactory from "../../packages/intercom/index.js";
import intercomHeavyFactory from "../../packages/intercom/index-heavy.js";
import { createForwardedHandlerMap, createHeavyProxy } from "../../packages/intercom/lazy-heavy-proxy.js";

const WAKE_TYPE = "intercom_subagent_wake";
const tempDirs: string[] = [];

beforeAll(() => {
	initTheme("dark", false);
});

afterEach(() => {
	delete process.env.NO_COLOR;
	initTheme("dark", false);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function wakeMessage(overrides?: {
	childName?: string;
	childId?: string;
	from?: { id: string; name?: string };
	depth?: number;
	content?: string;
	details?: unknown;
}) {
	const childName = overrides?.childName ?? "subagent-debugger-45255a2f-7";
	const childId = overrides && "childId" in overrides ? overrides.childId : "45255a2f:6";
	const from = overrides?.from ?? {
		id: "133acdf4-dc40-4f80-865c-ba1931d0a8cc",
		name: "subagent-worker-45255a2f-3",
	};
	const depth = overrides?.depth ?? 1;
	const waker = from.name ?? from.id;
	const content =
		overrides?.content ??
		`Resuming subagent \`${childName}\`${childId === undefined ? "" : ` (${childId})`} for an Intercom message from ${waker}. It stays this session's subagent: its result arrives here.`;
	const details = overrides && "details" in overrides ? overrides.details : { childName, childId, from, depth };
	return createCustomMessage(WAKE_TYPE, content, true, details, new Date(0).toISOString());
}

function plain(lines: readonly string[]): string[] {
	return lines.map((line) => stripVTControlCharacters(line));
}

async function loadAllThreeWakeRenderers(): Promise<{
	dormant: MessageRenderer;
	light: MessageRenderer;
	heavy: MessageRenderer;
}> {
	const dir = mkdtempSync(join(tmpdir(), "atomic-wake-renderers-"));
	tempDirs.push(dir);
	const [intercomEntry] = getMandatoryBuiltinExtensionPaths();
	assert.ok(intercomEntry, "mandatory intercom entry path must exist");

	// 1. Dormant lazy-builtin path (before Intercom module loads)
	const lazyLoaded = await loadExtensions([intercomEntry], dir);
	assert.deepEqual(lazyLoaded.errors, []);
	const dormant = lazyLoaded.extensions[0]!.messageRenderers.get(WAKE_TYPE);
	assert.ok(dormant, "dormant lazy-builtin intercom must register intercom_subagent_wake renderer");

	// 2. Light eager path (packages/intercom/index.ts before index-heavy loads)
	const lightExt = await loadExtensionFromFactory(
		intercomLightFactory,
		dir,
		createEventBus(),
		createExtensionRuntime(),
		intercomEntry,
	);
	const light = lightExt.messageRenderers.get(WAKE_TYPE);
	assert.ok(light, "light intercom/index.ts must register intercom_subagent_wake renderer");

	// 3. Heavy path (packages/intercom/index-heavy.ts via createHeavyProxy)
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
	const captured = {
		tools: new Map(),
		commands: new Map(),
		handlers: createForwardedHandlerMap(),
		shortcuts: new Map(),
		eventHandlers: new Map(),
	};
	const proxy = createHeavyProxy(basePi, captured);
	await intercomHeavyFactory(proxy);
	const heavy = heavyRenderers.get(WAKE_TYPE);
	assert.ok(
		heavy,
		"heavy intercom/index-heavy.ts must register intercom_subagent_wake renderer through lazy-heavy-proxy",
	);

	return { dormant, light, heavy };
}

describe("intercom_subagent_wake notice card renderer", () => {
	test("registers on dormant lazy-builtin, light index.ts, and heavy index-heavy.ts with byte-identical output", async () => {
		const { dormant, light, heavy } = await loadAllThreeWakeRenderers();
		const msg = wakeMessage();

		for (const themeName of ["dark", "light"] as const) {
			initTheme(themeName, false);
			for (const width of [80, 120]) {
				for (const expanded of [false, true]) {
					const opts = { expanded, outputPad: 1, keyText, keyHint };
					const rDormant = dormant(msg, opts, theme)?.render(width);
					const rLight = light(msg, opts, theme)?.render(width);
					const rHeavy = heavy(msg, opts, theme)?.render(width);
					assert.ok(rDormant && rDormant.length > 0);
					assert.deepEqual(
						rDormant,
						rLight,
						`dormant vs light mismatch (${themeName}, w=${width}, exp=${expanded})`,
					);
					assert.deepEqual(rLight, rHeavy, `light vs heavy mismatch (${themeName}, w=${width}, exp=${expanded})`);
				}
			}
		}
	});

	test("renders compact one-line collapsed notice with wake glyph, readable IDs, and dim hint at 120 cols without truncating names at 80 cols", async () => {
		const { light } = await loadAllThreeWakeRenderers();
		const msg = wakeMessage();
		const component = new CustomMessageComponent(msg, light);

		// Leading blank spacer + 1 compact notice row
		const rows120 = plain(component.render(120));
		assert.equal(rows120.length, 2, `expected leading spacer + 1 row at 120 cols, got:\n${rows120.join("\n")}`);
		const line120 = rows120[1]!;
		assert.ok(!line120.includes("[intercom_subagent_wake]"), "must not render bracketed customType");
		assert.ok(line120.startsWith(" ↻ "), `expected wake glyph prefix, got: ${line120}`);
		assert.ok(line120.includes("Woke subagent-debugger-…-7 for a message from subagent-worker-…-3"));
		assert.ok(
			line120.includes("· result arrives here"),
			"120-col header should include dim result-arrives-here hint",
		);
		assert.ok(!line120.includes("45255a2f"), "collapsed line must keep IDs readable, not raw run hashes");
		assert.ok(visibleWidth(line120) <= 120);

		// At 80 cols: drops trailing dim hint BEFORE truncating either readable name!
		const rows80 = plain(component.render(80));
		assert.equal(rows80.length, 2, `expected 1 compact row at 80 cols, got:\n${rows80.join("\n")}`);
		const line80 = rows80[1]!;
		assert.ok(
			line80.includes("Woke subagent-debugger-…-7 for a message from subagent-worker-…-3"),
			`80-col line must keep both readable names intact, got: ${line80}`,
		);
		assert.ok(visibleWidth(line80) <= 80);

		// Shorter names fit WITH the dim hint even at 80 cols
		const shortComp = new CustomMessageComponent(
			wakeMessage({ childName: "debugger", childId: "45255a2f:0", from: { id: "peer-1", name: "planner" } }),
			light,
		);
		const shortLine80 = plain(shortComp.render(80))[1]!;
		assert.ok(shortLine80.includes("Woke debugger for a message from planner · result arrives here"));
		assert.ok(visibleWidth(shortLine80) <= 80);
	});

	test("expands on Ctrl+O and on click anywhere on the card to show full raw IDs and ownership note", async () => {
		const { light } = await loadAllThreeWakeRenderers();
		const msg = wakeMessage({ depth: 2 });
		const component = new CustomMessageComponent(msg, light);

		assert.equal(isClickExpandableBlock(component), true);
		assert.equal(component.historyReplayable, true, "stateless wake card must declare historyReplayable");

		const collapsed = component.render(120);
		assert.equal(collapsed.length, 2);

		// Click on the notice row (row 1, under the leading spacer row 0)
		const area = component.clickArea(120);
		assert.deepEqual(area, { start: 1, end: 2 });
		const unit = clickedBlocks([component], 0, 120, 1);
		assert.ok(unit, "clicking the wake row must resolve a clickable block unit");

		let toggledTo: boolean | undefined;
		toggleClickedBlocks(unit, 120, (next) => {
			toggledTo = next;
		});
		assert.equal(toggledTo, true);
		assert.equal(component.isExpanded(), true);

		const expandedByClick = component.render(120);
		const expandedPlain = plain(expandedByClick).join("\n");
		assert.ok(expandedByClick.length > collapsed.length, "expanded view must reveal details");
		assert.ok(expandedPlain.includes("⎿"), "expanded details must use Atomic's ⎿ connector");
		assert.ok(expandedPlain.includes("subagent-debugger-45255a2f-7"), "expanded shows full raw childName");
		assert.ok(expandedPlain.includes("45255a2f:6"), "expanded shows childId");
		assert.ok(expandedPlain.includes("subagent-worker-45255a2f-3"), "expanded shows full raw sender name");
		assert.ok(expandedPlain.includes("133acdf4-dc40-4f80-865c-ba1931d0a8cc"), "expanded shows full sender id");
		assert.ok(expandedPlain.includes("2"), "expanded shows wake depth when > 1");
		assert.ok(expandedPlain.includes("result arrives here") || expandedPlain.includes("arrives here"));

		// Verify Ctrl+O (setExpanded) produces exact same rows as click!
		const ctrlOComp = new CustomMessageComponent(msg, light);
		ctrlOComp.setExpanded(true);
		assert.deepEqual(ctrlOComp.render(120), expandedByClick);

		// Clicking ANY row of the expanded card (including last detail row!) collapses it back
		const expandedArea = component.clickArea(120)!;
		assert.ok(expandedArea.end > 2);
		const lastRowUnit = clickedBlocks([component], 0, 120, expandedArea.end - 1)!;
		toggleClickedBlocks(lastRowUnit, 120, (next) => {
			toggledTo = next;
		});
		assert.equal(toggledTo, false);
		assert.equal(component.isExpanded(), false);
		assert.deepEqual(component.render(120), collapsed);
	});

	test("formats unnamed session aliases, raw UUID senders, legacy content-only entries, control chars, narrow widths, and NO_COLOR safely", async () => {
		const { light } = await loadAllThreeWakeRenderers();

		// Unnamed session alias + raw UUID sender
		const aliasMsg = wakeMessage({
			childName: "subagent-codebase-analyzer-abcdef12-12",
			from: {
				id: "01a1f9cf-710e-7473-97ee-f49c7a9ba131",
				name: "subagent-chat-01a1f9cf-710e-7473-97ee-f49c7a9ba131",
			},
		});
		const aliasLine = plain(new CustomMessageComponent(aliasMsg, light).render(120))[1]!;
		assert.ok(aliasLine.includes("subagent-codebase-analyzer-…-12"));
		assert.ok(aliasLine.includes("session 01a1f9cf"));
		assert.ok(!aliasLine.includes("710e-7473-97ee"));

		// Missing from.name (raw UUID only)
		const uuidOnlyMsg = wakeMessage({
			from: { id: "01a1f9cf-710e-7473-97ee-f49c7a9ba131" },
		});
		const uuidLine = plain(new CustomMessageComponent(uuidOnlyMsg, light).render(120))[1]!;
		assert.ok(uuidLine.includes("for a message from 01a1f9cf"));

		// Legacy content-only entry (details missing)
		const legacyMsg = wakeMessage({ details: undefined });
		const legacyLine = plain(new CustomMessageComponent(legacyMsg, light).render(120))[1]!;
		assert.ok(!legacyLine.includes("[intercom_subagent_wake]"));
		assert.ok(legacyLine.includes("Woke subagent-debugger-…-7 for a message from subagent-worker-…-3"));

		// Terminal control escape injection
		const evilMsg = wakeMessage({
			childName: "subagent-worker-45255a2f-1\x1b[31m\nINJECTED",
			from: { id: "bad\x1b[2J", name: "peer\r\nFAKE" },
		});
		const evilRows = new CustomMessageComponent(evilMsg, light).render(120);
		assert.equal(evilRows.length, 2);
		assert.doesNotMatch(stripVTControlCharacters(evilRows[1]!), /[\x00-\x1f\x7f]/);

		// Narrow widths never overflow or throw
		for (const w of [1, 5, 20, 40, 80, 120]) {
			const c = new CustomMessageComponent(wakeMessage(), light);
			for (const expanded of [false, true]) {
				c.setExpanded(expanded);
				const rows = c.render(w);
				assert.ok(rows.length >= 2);
				for (const row of rows)
					assert.ok(visibleWidth(row) <= w, `row overflowed width ${w}: ${stripVTControlCharacters(row)}`);
			}
		}

		// NO_COLOR strips all ANSI sequences
		process.env.NO_COLOR = "1";
		const noColorComp = new CustomMessageComponent(wakeMessage(), light);
		for (const expanded of [false, true]) {
			noColorComp.setExpanded(expanded);
			for (const row of noColorComp.render(120)) {
				assert.equal(row, stripVTControlCharacters(row), `ANSI leaked under NO_COLOR (expanded=${expanded})`);
			}
		}
	});
});
