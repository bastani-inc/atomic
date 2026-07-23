import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../packages/coding-agent/src/core/footer-data-provider.ts";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import { CACHE_TTL_MS, collectCacheMisses, computeCacheWaste } from "../../packages/coding-agent/src/core/cache-stats.ts";
import { KEYBINDINGS } from "../../packages/coding-agent/src/core/keybindings.ts";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { getUsageCostBreakdown } from "../../packages/coding-agent/src/core/usage-totals.ts";
import { shouldRunFirstTimeSetup } from "../../packages/coding-agent/src/cli/startup-ui.ts";
import { IdleStatus } from "../../packages/coding-agent/src/modes/interactive/components/idle-status.ts";
import { FooterComponent } from "../../packages/coding-agent/src/modes/interactive/components/footer.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { buildSettingsItems } from "../../packages/coding-agent/src/modes/interactive/components/settings-selector-items.ts";
import { readClipboardText } from "../../packages/coding-agent/src/utils/clipboard.ts";

const envSnapshot = { atomic: process.env.ATOMIC_CODING_AGENT_DIR, pi: process.env.PI_CODING_AGENT_DIR };
afterEach(() => {
	if (envSnapshot.atomic === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = envSnapshot.atomic;
	if (envSnapshot.pi === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = envSnapshot.pi;
});

function usage(input: number, cacheRead: number, costInput = input / 100_000): Usage {
	return { input, output: 10, cacheRead, cacheWrite: 0, totalTokens: input + cacheRead + 10, cost: { input: costInput, output: 0.01, cacheRead: cacheRead / 1_000_000, cacheWrite: 0, total: costInput + 0.01 + cacheRead / 1_000_000 } };
}
function assistant(timestamp: number, model: string, value: Usage, responseModel?: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text: "ok" }], api: "anthropic-messages", provider: "test", model, responseModel, usage: value, stopReason: "stop", timestamp };
}
function entry(id: string, message: AssistantMessage): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: new Date(message.timestamp).toISOString(), message };
}
const prices = { getModel: () => ({ cost: { cacheRead: 0.1 } }) };

describe("Group 5 parity", () => {
	test("copy-last-message and paste fallback keybindings are registered", () => {
		assert.equal(KEYBINDINGS["app.message.copy"].defaultKeys, "ctrl+x");
		assert.match(KEYBINDINGS["app.clipboard.pasteImage"].description, /text fallback/);
	});

	test("clipboard text reads never throw", async () => {
		assert.equal(await readClipboardText({ getText: async () => "pasted" }), "pasted");
		assert.equal(await readClipboardText({ getText: async () => { throw new Error("denied"); } }), null);
	});

	test("cache misses honor thresholds and report switch/idle attribution", () => {
		const entries = [entry("a", assistant(0, "one", usage(40_000, 1))), entry("b", assistant(CACHE_TTL_MS + 1, "two", usage(40_000, 0)))];
		const misses = collectCacheMisses(entries, prices);
		assert.equal(misses.size, 1);
		const miss = [...misses.values()][0]!;
		assert.equal(miss.modelChanged, true);
		assert.ok(miss.idleMs > CACHE_TTL_MS);
		assert.equal(computeCacheWaste(entries, prices).missCount, 1);
	});

	test("compaction and branch-summary boundaries reset cache comparisons", () => {
		const first = entry("a", assistant(0, "one", usage(40_000, 1)));
		const after = entry("c", assistant(1, "one", usage(40_000, 0)));
		const compaction: SessionEntry = { type: "compaction", id: "b", parentId: "a", timestamp: new Date(1).toISOString(), summary: "x", firstKeptEntryId: null, tokensBefore: 40_000 };
		assert.equal(computeCacheWaste([first, compaction, after], prices).missCount, 0);
	});

	test("usage breakdown attributes response model and summary usage", () => {
		const assistantEntry = entry("a", assistant(0, "requested", usage(10, 2), "actual"));
		const summary: SessionEntry = { type: "branch_summary", id: "b", parentId: "a", timestamp: new Date(1).toISOString(), fromId: "a", summary: "summary", usage: usage(5, 0) };
		assert.deepEqual(getUsageCostBreakdown([assistantEntry, summary]).map((item) => item.key), ["test/actual", "Tools/summaries"]);
	});

	test("analytics and cache notice settings persist with a stable tracking id", () => {
		const manager = SettingsManager.inMemory({});
		assert.equal(manager.getShowCacheMissNotices(), false);
		manager.setShowCacheMissNotices(true);
		manager.setEnableAnalytics(true);
		const id = manager.getTrackingId();
		assert.match(id ?? "", /^[0-9a-f-]{36}$/);
		manager.setEnableAnalytics(true);
		assert.equal(manager.getTrackingId(), id);
		assert.equal(manager.getShowCacheMissNotices(), true);
	});

	test("first-run eligibility requires default agent dir and absent settings", () => {
		delete process.env.ATOMIC_CODING_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_DIR;
		assert.equal(shouldRunFirstTimeSetup(`/tmp/atomic-missing-${crypto.randomUUID()}.json`), true);
		process.env.ATOMIC_CODING_AGENT_DIR = "/tmp/custom";
		assert.equal(shouldRunFirstTimeSetup(`/tmp/atomic-missing-${crypto.randomUUID()}.json`), false);
	});
	test("settings place output padding before autocomplete and expose cache notices", () => {
		const items = buildSettingsItems({
			autoCompact: true, showImages: true, imageWidthCells: 60, autoResizeImages: true, blockImages: false,
			enableSkillCommands: true, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", transport: "auto",
			httpIdleTimeoutMs: 300_000, bashInterceptorEnabled: false, thinkingLevel: "off", availableThinkingLevels: ["off"],
			currentTheme: "dark", terminalTheme: "dark", availableThemes: ["dark"], hideThinkingBlock: false,
			collapseChangelog: false, enableInstallTelemetry: true, doubleEscapeAction: "tree", treeFilterMode: "default",
			showHardwareCursor: false, editorPaddingX: 0, outputPad: 1, showCacheMissNotices: false,
			autocompleteMaxVisible: 5, quietStartup: false, defaultProjectTrust: "ask", clearOnShrink: false,
			showTerminalProgress: false, warnings: {},
		}, {} as never);
		const ids = items.map((item) => item.id);
		assert.ok(ids.indexOf("output-padding") < ids.indexOf("autocomplete-max-visible"));
		assert.ok(ids.includes("cache-miss-notices"));
	});

	test("idle status fills two rows", () => {
		assert.deepEqual(new IdleStatus().render(4), ["    ", "    "]);
	});
	test("footer renders branch, session name, and sorted sanitized extension statuses", () => {
		initTheme("dark");
		const session = {
			state: { model: undefined, thinkingLevel: "off" },
			isStreaming: false,
			sessionManager: { getCwd: () => "/tmp/project", getSessionName: () => "demo" },
			settingsManager: { getCodexFastModeSettings: () => ({ chat: false, workflow: false }) },
		} as never as AgentSession;
		const footerData = {
			getGitBranch: () => "feature",
			getExtensionStatuses: () => new Map([["z", "zeta\nstatus"], ["a", "alpha\tstatus"]]),
			getAvailableProviderCount: () => 1,
			onBranchChange: () => () => {},
		} satisfies ReadonlyFooterDataProvider;
		const lines = new FooterComponent(session, footerData).render(120).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
		assert.match(lines[0] ?? "", /project \(feature\).*demo/);
		assert.equal(lines[1], "alpha status zeta status");
	});

	test("footer keeps ANSI-colored extension statuses intact instead of leaking stripped sequences", () => {
		initTheme("dark");
		const session = {
			state: { model: undefined, thinkingLevel: "off" },
			isStreaming: false,
			sessionManager: { getCwd: () => "/tmp/project", getSessionName: () => undefined },
			settingsManager: { getCodexFastModeSettings: () => ({ chat: false, workflow: false }) },
		} as never as AgentSession;
		const colored = "\u001b[38;2;137;180;250mMCP: 0/1 servers\u001b[39m";
		const footerData = {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map([["mcp", colored]]),
			getAvailableProviderCount: () => 1,
			onBranchChange: () => () => {},
		} satisfies ReadonlyFooterDataProvider;
		const statusLine = new FooterComponent(session, footerData).render(120).at(-1) ?? "";
		assert.ok(statusLine.includes(colored), "the colored status must render with its escape sequences intact");
		assert.ok(!statusLine.replace(/\u001b\[[0-9;]*m/g, "").includes("[38;2"), "no bare SGR remnants may leak into the visible footer text");
	});
});
