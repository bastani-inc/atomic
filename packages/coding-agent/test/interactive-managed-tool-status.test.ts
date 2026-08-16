import assert from "node:assert/strict";
import { type Component, Container, type Spacer, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import type { ToolStatus } from "../src/utils/tools-manager.js";

const toolMocks = vi.hoisted(() => ({
	ensureTool: vi.fn<(tool: "fd" | "rg", onStatus?: (status: ToolStatus) => void) => Promise<string | undefined>>(),
}));

vi.mock("../src/utils/tools-manager.js", () => ({ ensureTool: toolMocks.ensureTool }));

/**
 * Upstream `6f707eb3`, the Atomic half: `ensureTool(tool, onStatus)` reports
 * through a callback, and interactive startup routes those reports into the
 * transcript. A console write during deferred startup lands in the alternate
 * screen and corrupts the frame, which is exactly what the old
 * `console.error` in the readiness catch produced.
 */

type ManagedToolsThis = {
	fdPath: string | undefined;
	managedToolStatusStarted: boolean;
	managedToolStatusGeneration: number;
	lastStatusSpacer: Spacer | undefined;
	lastStatusText: Text | undefined;
	chatContainer: Container;
	ui: { requestRender: ReturnType<typeof vi.fn> };
	setupAutocompleteProvider: ReturnType<typeof vi.fn>;
	showManagedToolStatus: (status: ToolStatus) => void;
	pendingMessagesContainer: Container;
	compactionQueuedMessages: never[];
	streamingComponent: Component | undefined;
	streamingMessage: object | undefined;
	pendingTools: Map<string, Component>;
	renderInitialMessages: ReturnType<typeof vi.fn>;
	attachStartupNoticesContainer: ReturnType<typeof vi.fn>;
	renderSessionEntries: ReturnType<typeof vi.fn>;
	sessionManager: { getEntries: ReturnType<typeof vi.fn>; getLeafId: ReturnType<typeof vi.fn> };
};

const prototype = InteractiveMode.prototype as unknown as {
	ensureManagedToolsReady(this: ManagedToolsThis): Promise<void>;
	showManagedToolStatus(this: ManagedToolsThis, status: ToolStatus): void;
	renderCurrentSessionState(this: ManagedToolsThis): void;
	rebuildChatFromMessages(this: ManagedToolsThis): void;
};

function createMode(): ManagedToolsThis {
	const mode: ManagedToolsThis = {
		fdPath: undefined,
		managedToolStatusStarted: false,
		managedToolStatusGeneration: 0,
		lastStatusSpacer: undefined,
		lastStatusText: undefined,
		chatContainer: new Container(),
		ui: { requestRender: vi.fn() },
		setupAutocompleteProvider: vi.fn(),
		showManagedToolStatus: undefined as never,
		pendingMessagesContainer: new Container(),
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map(),
		renderInitialMessages: vi.fn(),
		attachStartupNoticesContainer: vi.fn(),
		renderSessionEntries: vi.fn(),
		sessionManager: { getEntries: vi.fn(() => []), getLeafId: vi.fn(() => null) },
	};
	mode.showManagedToolStatus = (status) => prototype.showManagedToolStatus.call(mode, status);
	return mode;
}

function transcriptText(mode: ManagedToolsThis): string {
	return mode.chatContainer.children.flatMap((child) => child.render(80)).join("\n");
}

beforeEach(() => {
	initTheme("dark");
	toolMocks.ensureTool.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

test("keeps current readiness callbacks across a same-session transcript rebuild", async () => {
	const mode = createMode();
	const callbacks: Array<(status: ToolStatus) => void> = [];
	const resolveTools: Array<(path: string | undefined) => void> = [];
	toolMocks.ensureTool.mockImplementation((_tool, onStatus) => {
		if (onStatus) callbacks.push(onStatus);
		return new Promise<string | undefined>((resolve) => resolveTools.push(resolve));
	});

	const readiness = prototype.ensureManagedToolsReady.call(mode);
	assert.equal(callbacks.length, 2);
	const beforeRebuild = callbacks[0];
	const afterRebuild = callbacks[1];
	assert.ok(beforeRebuild);
	assert.ok(afterRebuild);
	beforeRebuild({ type: "info", message: "before same-session rebuild" });
	assert.match(transcriptText(mode), /before same-session rebuild/u);

	mode.renderSessionEntries.mockImplementation(() => {
		mode.chatContainer.addChild(new Text("same session transcript", 1, 0));
	});
	prototype.rebuildChatFromMessages.call(mode);
	afterRebuild({ type: "warning", message: "after same-session rebuild" });

	const after = transcriptText(mode);
	assert.match(after, /same session transcript/u);
	assert.match(after, /Warning: after same-session rebuild/u);
	assert.equal(mode.chatContainer.children.length, 3, "transcript marker, one status spacer, and one status row");
	for (const resolve of resolveTools) resolve(undefined);
	await readiness;
});
test("ignores readiness callbacks from a prior transcript after a session rebuild", async () => {
	const mode = createMode();
	const oldCallbacks: Array<(status: ToolStatus) => void> = [];
	const resolveOldTools: Array<(path: string | undefined) => void> = [];
	toolMocks.ensureTool.mockImplementation((_tool, onStatus) => {
		if (onStatus) oldCallbacks.push(onStatus);
		return new Promise<string | undefined>((resolve) => resolveOldTools.push(resolve));
	});

	const oldReadiness = prototype.ensureManagedToolsReady.call(mode);
	assert.equal(oldCallbacks.length, 2);
	assert.equal(resolveOldTools.length, 2);
	const oldStatus = oldCallbacks[0];
	const oldWarning = oldCallbacks[1];
	assert.ok(oldStatus);
	assert.ok(oldWarning);
	mode.renderInitialMessages.mockImplementation(() => {
		mode.chatContainer.addChild(new Text("replacement session", 1, 0));
	});
	prototype.renderCurrentSessionState.call(mode);
	oldStatus({ type: "info", message: "stale startup status" });
	assert.equal(transcriptText(mode).includes("replacement session"), true);
	assert.equal(transcriptText(mode).includes("stale startup status"), false);

	toolMocks.ensureTool.mockImplementation(async (_tool, onStatus) => {
		onStatus?.({ type: "info", message: "current startup status" });
		return "/tools/current";
	});
	await prototype.ensureManagedToolsReady.call(mode);
	oldWarning({ type: "warning", message: "stale failure status" });
	assert.equal(transcriptText(mode).includes("current startup status"), true);
	assert.equal(transcriptText(mode).includes("stale failure status"), false);

	for (const resolve of resolveOldTools) resolve(undefined);
	await oldReadiness;
});

test("managed-tool warnings land in the transcript, never on the console", async () => {
	const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	const mode = createMode();
	toolMocks.ensureTool.mockImplementation(async (tool, onStatus) => {
		onStatus?.({
			type: "warning",
			message: `${tool === "fd" ? "fd" : "ripgrep"} not found. Offline mode enabled, skipping download.`,
		});
		return undefined;
	});

	await prototype.ensureManagedToolsReady.call(mode);

	expect(consoleLog).not.toHaveBeenCalled();
	expect(consoleError).not.toHaveBeenCalled();
	expect(transcriptText(mode)).toContain("Warning: fd not found. Offline mode enabled, skipping download.");
	expect(transcriptText(mode)).toContain("Warning: ripgrep not found. Offline mode enabled, skipping download.");
	expect(mode.ui.requestRender).toHaveBeenCalled();
	expect(mode.setupAutocompleteProvider).toHaveBeenCalled();
	expect(mode.fdPath).toBeUndefined();
});

test("info statuses render dim without the Warning prefix and share one spacer", async () => {
	const mode = createMode();
	toolMocks.ensureTool.mockImplementation(async (tool, onStatus) => {
		if (tool === "rg") return "/tools/rg";
		onStatus?.({ type: "info", message: "fd not found. Downloading..." });
		onStatus?.({ type: "info", message: "fd installed to /tools/fd" });
		return "/tools/fd";
	});

	await prototype.ensureManagedToolsReady.call(mode);

	expect(transcriptText(mode)).toContain("fd not found. Downloading...");
	expect(transcriptText(mode)).toContain("fd installed to /tools/fd");
	expect(transcriptText(mode)).not.toContain("Warning:");
	// One spacer for the whole block: the first status opens it and the second
	// reuses it rather than stacking blank rows between updates.
	expect(mode.chatContainer.children).toHaveLength(3);
	expect(mode.fdPath).toBe("/tools/fd");
});

test("a rejected readiness check reports into the transcript instead of console.error", async () => {
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	const mode = createMode();
	toolMocks.ensureTool.mockImplementation((tool) =>
		tool === "fd" ? Promise.reject(new Error("spawn failed")) : Promise.resolve("/tools/rg"),
	);

	await expect(prototype.ensureManagedToolsReady.call(mode)).resolves.toBeUndefined();

	expect(consoleError).not.toHaveBeenCalled();
	expect(transcriptText(mode)).toContain("Warning: Tool readiness check failed: spawn failed");
});
