import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { renderLastLine } from "./interactive-mode-status-helpers.ts";

// Upstream pi 0.79.1 also exercises overlay focus restoration with packages/tui's
// VirtualTerminal harness. Atomic consumes @earendil-works/pi-tui as a dependency
// rather than vendoring that test harness, so this suite keeps the equivalent
// package-level interactive status/autocomplete coverage that can run here.
describe("InteractiveMode.showStatus", () => {
	beforeAll(() => {
		// showStatus uses the global theme instance
		initTheme("dark");
	});

	test("coalesces immediately-sequential status messages", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_ONE");

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// second status updates the previous line instead of appending
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(fakeThis.chatContainer)).not.toContain("STATUS_ONE");
	});

	test("appends a new status line if something else was added in between", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);

		// Something else gets added to the chat in between status updates
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		expect(fakeThis.chatContainer.children).toHaveLength(3);

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// adds spacer + text
		expect(fakeThis.chatContainer.children).toHaveLength(5);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
	});
});

describe("InteractiveMode.setToolsExpanded", () => {
	test("applies expansion state to the active header and chat entries", () => {
		const header = { setExpanded: vi.fn() };
		const chatChild = { setExpanded: vi.fn() };
		const fakeThis: any = {
			toolOutputExpanded: false,
			customHeader: undefined,
			builtInHeader: header,
			chatContainer: { children: [chatChild] },
			ui: { requestRender: vi.fn() },
		};

		(InteractiveMode as any).prototype.setToolsExpanded.call(fakeThis, true);

		expect(fakeThis.toolOutputExpanded).toBe(true);
		expect(header.setExpanded).toHaveBeenCalledWith(true);
		expect(chatChild.setExpanded).toHaveBeenCalledWith(true);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode.handleEvent model changes", () => {
	test("refreshes the built-in header when the active model changes", async () => {
		const fakeThis: any = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			refreshBuiltInHeader: vi.fn(),
			updateEditorBorderColor: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handleEvent.call(fakeThis, {
			type: "model_changed",
			model: { id: "faux-2", provider: "faux" },
			previousModel: { id: "faux-1", provider: "faux" },
			source: "set",
		});

		expect(fakeThis.footer.invalidate).toHaveBeenCalledTimes(1);
		expect(fakeThis.refreshBuiltInHeader).toHaveBeenCalledTimes(1);
		expect(fakeThis.updateEditorBorderColor).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode /trust", () => {
	test("uses the active runtime agentDir for saved decisions", () => {
		const root = mkdtempSync(path.join(tmpdir(), "atomic-trust-selector-agent-dir-"));
		try {
			const cwd = path.join(root, "project");
			const runtimeAgentDir = path.join(root, "runtime-agent");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(runtimeAgentDir, { recursive: true });
			let createdSelector: { handleInput(input: string): void } | undefined;
			const fakeThis = {
				sessionManager: { getCwd: () => cwd },
				settingsManager: { isProjectTrusted: () => false },
				runtimeHost: { services: { agentDir: runtimeAgentDir } },
				showStatus: vi.fn(),
				ui: { requestRender: vi.fn() },
				showSelector: vi.fn((factory: (done: () => void) => { component: { handleInput(input: string): void } }) => {
					createdSelector = factory(vi.fn()).component;
				}),
			};

			(InteractiveMode as any).prototype.showTrustSelector.call(fakeThis);
			createdSelector?.handleInput("\n");

			expect(new ProjectTrustStore(runtimeAgentDir).get(cwd)).toBe(true);
			expect(fakeThis.showStatus).toHaveBeenCalledWith(
				expect.stringContaining("Saved trust decision: trusted"),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("InteractiveMode reload project trust", () => {
	test("persists implicit startup trust after reload creates project config", () => {
		const root = mkdtempSync(path.join(tmpdir(), "atomic-reload-trust-"));
		try {
			const cwd = path.join(root, "project");
			const agentDir = path.join(root, "agent");
			mkdirSync(path.join(cwd, ".atomic"), { recursive: true });
			mkdirSync(agentDir, { recursive: true });

			const fakeThis = {
				autoTrustOnReloadCwd: cwd,
				sessionManager: { getCwd: () => cwd },
				settingsManager: { isProjectTrusted: () => true },
				runtimeHost: { services: { agentDir } },
				showWarning: vi.fn(),
			};

			const saved = (InteractiveMode as any).prototype.maybeSaveImplicitProjectTrustAfterReload.call(fakeThis);

			expect(saved).toBe(true);
			expect(new ProjectTrustStore(agentDir).get(cwd)).toBe(true);
			expect(fakeThis.autoTrustOnReloadCwd).toBeUndefined();
			expect(fakeThis.showWarning).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("InteractiveMode.createExtensionUIContext setTheme", () => {
	test("persists theme changes to settings manager", () => {
		initTheme("dark");

		let currentTheme = "dark";
		const settingsManager = {
			getTheme: vi.fn(() => currentTheme),
			getThemeSetting: vi.fn(() => currentTheme),
			setTheme: vi.fn((theme: string) => {
				currentTheme = theme;
			}),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			themeController: {
				setThemeInstance: vi.fn(() => ({ success: true })),
				setThemeName: vi.fn(() => {
					fakeThis.ui.requestRender();
					return { success: true };
				}),
			},
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("light");

		expect(result.success).toBe(true);
		expect(fakeThis.themeController.setThemeName).toHaveBeenCalledWith("light");
		expect(settingsManager.setTheme).toHaveBeenCalledWith("light");
		expect(currentTheme).toBe("light");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("does not persist invalid theme names", () => {
		initTheme("dark");

		const settingsManager = {
			getTheme: vi.fn(() => "dark"),
			getThemeSetting: vi.fn(() => "dark"),
			setTheme: vi.fn(),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			themeController: {
				setThemeInstance: vi.fn(() => ({ success: true })),
				setThemeName: vi.fn(() => ({ success: false, error: "Theme not found" })),
			},
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("__missing_theme__");

		expect(result.success).toBe(false);
		expect(fakeThis.themeController.setThemeName).toHaveBeenCalledWith("__missing_theme__");
		expect(settingsManager.setTheme).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});

