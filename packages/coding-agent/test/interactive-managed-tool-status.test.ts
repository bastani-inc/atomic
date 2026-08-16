import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import type { ToolStatus } from "../src/utils/tools-manager.ts";

const toolMocks = vi.hoisted(() => ({
	ensureTool: vi.fn<(tool: "fd" | "rg", onStatus?: (status: ToolStatus) => void) => Promise<string | undefined>>(),
}));

vi.mock("../src/utils/tools-manager.ts", () => ({ ensureTool: toolMocks.ensureTool }));

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
	lastStatusSpacer: unknown;
	lastStatusText: unknown;
	chatContainer: { children: unknown[]; addChild: (child: unknown) => void };
	ui: { requestRender: ReturnType<typeof vi.fn> };
	setupAutocompleteProvider: ReturnType<typeof vi.fn>;
	showManagedToolStatus: (status: ToolStatus) => void;
};

const prototype = InteractiveMode.prototype as unknown as {
	ensureManagedToolsReady(this: ManagedToolsThis): Promise<void>;
	showManagedToolStatus(this: ManagedToolsThis, status: ToolStatus): void;
};

function createMode(): ManagedToolsThis {
	const mode: ManagedToolsThis = {
		fdPath: undefined,
		managedToolStatusStarted: false,
		lastStatusSpacer: undefined,
		lastStatusText: undefined,
		chatContainer: {
			children: [],
			addChild(child: unknown) {
				this.children.push(child);
			},
		},
		ui: { requestRender: vi.fn() },
		setupAutocompleteProvider: vi.fn(),
		showManagedToolStatus: undefined as never,
	};
	mode.showManagedToolStatus = (status) => prototype.showManagedToolStatus.call(mode, status);
	return mode;
}

function transcriptText(mode: ManagedToolsThis): string {
	return mode.chatContainer.children
		.flatMap((child) => (child as { render?: (width: number) => string[] }).render?.(80) ?? [])
		.join("\n");
}

beforeEach(() => {
	initTheme("dark");
	toolMocks.ensureTool.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
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
