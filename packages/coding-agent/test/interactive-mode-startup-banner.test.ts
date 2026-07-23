import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { ENV_CODEX_FAST_MODE } from "../src/config.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { FastModeSelectorComponent } from "../src/modes/interactive/components/fast-mode-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function plain(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

interface StartupIdentityAccess {
	getStartupIdentityText(maxWidth?: number): string;
}

interface FastModeSelectorAccess {
	showFastModeSelector(): void;
}

function renderStartupIdentity(options: {
	chatFastMode: boolean;
	reasoning: boolean;
	thinkingLevel: ThinkingLevel;
	maxWidth?: number;
}): string {
	const session = {
		state: {
			model: {
				provider: "openai",
				id: "gpt-5.1-codex",
				reasoning: options.reasoning,
			},
			thinkingLevel: options.thinkingLevel,
		},
		thinkingLevel: options.thinkingLevel,
		settingsManager: {
			getCodexFastModeSettings: () => ({
				chat: options.chatFastMode,
				workflow: false,
			}),
		},
		orchestrationContext: undefined,
		sessionManager: {
			getCwd: () => "/tmp/project",
		},
	} as unknown as AgentSession;
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		version: "0.0.0",
		runtimeHost: { session },
	});

	return plain((mode as StartupIdentityAccess).getStartupIdentityText(options.maxWidth));
}

describe("InteractiveMode startup banner", () => {
	it("shows fast after the reasoning level when chat fast mode applies", () => {
		initTheme("dark");
		const rendered = renderStartupIdentity({
			chatFastMode: true,
			reasoning: true,
			thinkingLevel: "medium",
		});

		expect(rendered).toContain("(openai) gpt-5.1-codex medium fast");
		expect(rendered).not.toContain("gpt-5.1-codex fast medium");
	});

	it("keeps the side-by-side layout when the terminal is wide enough", () => {
		initTheme("dark");
		const rendered = renderStartupIdentity({
			chatFastMode: false,
			reasoning: false,
			thinkingLevel: "off",
			maxWidth: 120,
		});

		const lines = rendered.split("\n");
		expect(lines[0]).toContain("██████");
		expect(lines[0]).toContain("Atomic v0.0.0");
	});

	it("stacks the identity text under the logo when the meta column would wrap", () => {
		initTheme("dark");
		const rendered = renderStartupIdentity({
			chatFastMode: false,
			reasoning: false,
			thinkingLevel: "off",
			maxWidth: 40,
		});

		const lines = rendered.split("\n");
		// No line mixes logo art with identity text (which is what wrapped
		// and shredded the logo on narrow terminals).
		for (const line of lines) {
			if (line.includes("██████")) {
				expect(line.trimEnd().length).toBeLessThanOrEqual(40);
				expect(line).not.toContain("Atomic");
				expect(line).not.toContain("openai");
			}
		}
		expect(lines.some((line) => line.includes("██████"))).toBe(true);
		expect(rendered).toContain("Atomic v0.0.0");
		expect(rendered).toContain("(openai) gpt-5.1-codex");
		expect(rendered).toContain("/tmp/project");
	});

	it("drops the logo art entirely when the terminal is narrower than the logo", () => {
		initTheme("dark");
		const rendered = renderStartupIdentity({
			chatFastMode: false,
			reasoning: false,
			thinkingLevel: "off",
			maxWidth: 20,
		});

		expect(rendered).not.toContain("█");
		expect(rendered).toContain("Atomic v0.0.0");
		expect(rendered).toContain("(openai) gpt-5.1-codex");
		expect(rendered).toContain("/tmp/project");
	});

	it("refreshes the banner and inherited child fast-mode state when /fast changes", async () => {
		initTheme("dark");
		const previous = process.env[ENV_CODEX_FAST_MODE];
		let settings = { chat: false, workflow: false };
		let selector: FastModeSelectorComponent | undefined;
		const settingsManager = {
			flush: vi.fn(),
			getCodexFastModeSettings: () => settings,
			setCodexFastModeSettings: vi.fn((next: Partial<typeof settings>) => {
				settings = { ...settings, ...next };
			}),
		};
		const fakeMode = Object.assign(Object.create(InteractiveMode.prototype), {
			footer: { invalidate: vi.fn() },
			hasCodexFastModeSupportedModels: () => true,
			refreshBuiltInHeader: vi.fn(),
			runtimeHost: { session: { settingsManager } },
			showSelector: (create: (done: () => void) => { component: FastModeSelectorComponent }) => {
				selector = create(() => {}).component;
			},
			showStatus: vi.fn(),
			ui: { requestRender: vi.fn() },
		});

		try {
			(fakeMode as unknown as FastModeSelectorAccess).showFastModeSelector();
			selector?.handleInput("\x1b[C");

			expect(settingsManager.setCodexFastModeSettings).toHaveBeenCalledWith({ chat: true });
			expect(fakeMode.footer.invalidate).toHaveBeenCalledTimes(1);
			expect(fakeMode.refreshBuiltInHeader).toHaveBeenCalledTimes(1);
			expect(fakeMode.showStatus).not.toHaveBeenCalled();
			expect(process.env[ENV_CODEX_FAST_MODE]).toBe("chat=1;workflow=0");

			selector?.handleInput("\x1b");
			await Promise.resolve();

			expect(settingsManager.flush).toHaveBeenCalledTimes(1);
			expect(fakeMode.showStatus).toHaveBeenCalledWith("Chat fast mode on");
		} finally {
			if (previous === undefined) {
				delete process.env[ENV_CODEX_FAST_MODE];
			} else {
				process.env[ENV_CODEX_FAST_MODE] = previous;
			}
		}
	});
});
