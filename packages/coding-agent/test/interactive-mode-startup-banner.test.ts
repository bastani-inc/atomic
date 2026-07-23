import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { TUI, type Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { ENV_CODEX_FAST_MODE } from "../src/config.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { FastModeSelectorComponent } from "../src/modes/interactive/components/fast-mode-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { registerStartupInputListeners } from "../src/modes/interactive/interactive-input-handling.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import {
	STARTUP_ASSEMBLY_GAPS,
	composeStartupIdentity,
	renderAtomicAssemblyBanner,
	renderStartupManifesto,
} from "../src/modes/interactive/components/atomic-banner.ts";
import { StartupIdentityComponent, startupStateAtElapsed } from "../src/modes/interactive/components/startup-identity.ts";

function plain(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

interface StartupIdentityAccess {
	getStartupIdentityText(maxWidth?: number, gap?: number, manifestoPhase?: number): string;
}

interface FastModeSelectorAccess {
	showFastModeSelector(): void;
}

class StartupTerminal implements Terminal {
	columns = 100;
	rows = 40;
	kittyProtocolActive = true;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

function renderStartupIdentity(options: {
	chatFastMode: boolean;
	reasoning: boolean;
	thinkingLevel: ThinkingLevel;
	maxWidth?: number;
	gap?: number;
	manifestoPhase?: number;
	raw?: boolean;
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

	const rendered = (mode as StartupIdentityAccess).getStartupIdentityText(
		options.maxWidth,
		options.gap,
		options.manifestoPhase,
	);
	return options.raw ? rendered : plain(rendered);
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

	it("keeps textual identity visible throughout assembly on terminals narrower than the mark", () => {
		initTheme("dark");
		for (const gap of STARTUP_ASSEMBLY_GAPS.slice(0, -1)) {
			const rendered = renderStartupIdentity({
				chatFastMode: false,
				reasoning: false,
				thinkingLevel: "off",
				maxWidth: 20,
				gap,
			});
			expect(rendered, `gap ${gap}`).not.toBe("");
			expect(rendered).toContain("Atomic v0.0.0");
			expect(rendered).not.toContain("█");
		}
	});

	it("honors NO_COLOR across the complete startup identity", () => {
		const previous = process.env.NO_COLOR;
		process.env.NO_COLOR = "";
		try {
			initTheme("dark");
			for (const state of [{ gap: 4, manifestoPhase: 0 }, { gap: 0, manifestoPhase: 4 }]) {
				const rendered = renderStartupIdentity({
					chatFastMode: false,
					reasoning: false,
					thinkingLevel: "medium",
					maxWidth: 120,
					...state,
					raw: true,
				});
				expect(plain(rendered).trim()).not.toBe("");
				if (state.gap === 0) expect(rendered).toContain("Atomic v0.0.0");
				expect(rendered).not.toMatch(/\u001b\[(?:38;|39m)/);
			}
		} finally {
			if (previous === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = previous;
		}
	});

	it("assembles in exact whole-column steps before landing shadow", () => {
		initTheme("dark");
		expect(STARTUP_ASSEMBLY_GAPS).toEqual([10, 8, 6, 4, 3, 2, 1, 1, 0]);
		for (const gap of STARTUP_ASSEMBLY_GAPS.slice(0, -1)) {
			const frame = renderAtomicAssemblyBanner(gap, theme, "off").map(plain);
			expect(frame).toHaveLength(11);
			expect(frame.every((line) => line.length === 36)).toBe(true);
			expect(frame.join(""), `gap ${gap}`).not.toContain("░");
		}
		expect(renderAtomicAssemblyBanner(0, theme, "off").map(plain).join("")).toContain("░");
	});

	it("holds the landed identity before three 80ms manifesto phrases", () => {
		expect([0, 80, 160, 240, 320, 400, 480, 560, 640].map((ms) => startupStateAtElapsed(ms).gap))
			.toEqual([10, 8, 6, 4, 3, 2, 1, 1, 0]);
		expect(startupStateAtElapsed(799).manifestoPhase).toBe(0);
		expect(startupStateAtElapsed(800).manifestoPhase).toBe(1);
		expect(startupStateAtElapsed(880).manifestoPhase).toBe(2);
		expect(startupStateAtElapsed(960).manifestoPhase).toBe(3);
		expect(startupStateAtElapsed(1040)).toEqual({ gap: 0, manifestoPhase: 4, complete: true });
	});
	it("settles immediately without consuming input and renders the complete reduced-motion state", () => {
		const requestRender = vi.fn();
		const component = new StartupIdentityComponent(
			{ requestRender } as never,
			(_width, state) => JSON.stringify(state),
			true,
		);
		expect(component.settle()).toBe(true);
		expect(component.settle()).toBe(false);
		expect(component.render(64).join("\n")).toContain('"manifestoPhase":4');
		expect(requestRender).toHaveBeenCalled();
		const staticComponent = new StartupIdentityComponent(
			{ requestRender } as never,
			(_width, state) => JSON.stringify(state),
			false,
		);
		expect(staticComponent.render(64).join("\n")).toContain('"complete":true');
	});

	it("settles ordinary input and Ctrl+C through the real TUI listener chain", () => {
		const tui = new TUI(new StartupTerminal());
		const editorInputs: string[] = [];
		const editor = {
			render: () => [],
			invalidate: () => {},
			handleInput: (data: string) => { editorInputs.push(data); },
		};
		tui.setFocus(editor);
		const handleCtrlC = vi.fn();
		const mode = {
			ui: tui,
			builtInHeader: new StartupIdentityComponent(tui, () => "identity", true),
			keybindings: new KeybindingsManager(),
			blockingInlineCustomUiDepth: 0,
			editor,
			editorContainer: { children: [editor] },
			handleCtrlC,
		};
		registerStartupInputListeners(mode as never);
		(tui as unknown as { handleInput(data: string): void }).handleInput("x");
		expect(mode.builtInHeader.settle()).toBe(false);
		expect(editorInputs).toEqual(["x"]);

		mode.builtInHeader = new StartupIdentityComponent(tui, () => "identity", true);
		(tui as unknown as { handleInput(data: string): void }).handleInput("\x03");
		expect(mode.builtInHeader.settle()).toBe(false);
		expect(handleCtrlC).toHaveBeenCalledTimes(1);
		expect(editorInputs).toEqual(["x"]);
	});
	it("hands the landed identity into manifesto beats and stacks at 64 columns", () => {
		initTheme("dark");
		const mark = renderAtomicAssemblyBanner(0, theme, "off");
		const meta = ["Atomic v0.0.0", "(openai) model", "/tmp/project"];
		expect(plain(composeStartupIdentity(mark, meta, 120, renderStartupManifesto(0)))).not.toContain("We question,");
		expect(plain(composeStartupIdentity(mark, meta, 120, renderStartupManifesto(1)))).toContain("We question,");
		expect(plain(composeStartupIdentity(mark, meta, 120, renderStartupManifesto(2)))).toContain("we break away from what is accepted.");
		const final = plain(composeStartupIdentity(mark, meta, 64, renderStartupManifesto(4)));
		expect(final).toContain("Engineering matters.");
		expect(final.split("\n").every((line) => line.length <= 64)).toBe(true);
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
