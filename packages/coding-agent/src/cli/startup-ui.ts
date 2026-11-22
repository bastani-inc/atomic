import {
	Container,
	decodePrintableKey,
	type Focusable,
	getKeybindings,
	ProcessTerminal,
	setCapabilityOverrides,
	setKeybindings,
	Text,
	type TUI,
	TuiMainScreen,
} from "@bastani/atomic-tui";
import { getAgentDir } from "../config.js";
import type { ExtensionUIDialogOptions } from "../core/extensions/index.js";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { keepStartupDialogDraft, withEarlyInputHeldForStartupDialog } from "../main-early-input.ts";
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import {
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "../modes/interactive/components/first-time-setup.ts";
import {
	type GuardedDecision,
	isTrustDecision,
	STARTUP_DECISION_TYPED_TEXT_NOTICE,
	safeTrustChoiceIndex,
	TrustDecisionSelector,
} from "../modes/interactive/components/trust-decision-selector.ts";
import {
	detectTerminalThemeForAuto,
	initTheme,
	setTheme,
	type TerminalTheme,
	theme,
} from "../modes/interactive/theme/theme.js";
import { shouldRunFirstTimeSetup } from "./first-time-setup-check.ts";

export { shouldRunFirstTimeSetup };

export class StartupDialogInputGuard extends Container implements Focusable {
	private enterArmed: boolean;
	private readonly notice = new Text("", 1, 0);
	private readonly decision: GuardedDecision & Focusable;

	constructor(
		decision: GuardedDecision & Focusable,
		hasUnfinishedInput: boolean,
		noticeText: string = STARTUP_DECISION_TYPED_TEXT_NOTICE,
	) {
		super();
		this.decision = decision;
		this.enterArmed = !hasUnfinishedInput;
		if (!this.enterArmed) this.notice.setText(theme.fg("warning", noticeText));
		this.addChild(decision);
		this.addChild(this.notice);
	}

	get focused(): boolean {
		return this.decision.focused;
	}

	set focused(value: boolean) {
		this.decision.focused = value;
	}

	get capturesViewportInput(): boolean {
		return this.decision.capturesViewportInput ?? false;
	}

	handleInput(data: string): boolean {
		if (!this.enterArmed) {
			const keybindings = getKeybindings();
			if (
				keybindings.matches(data, "tui.select.confirm") ||
				keybindings.matches(data, "tui.input.submit") ||
				data === "\n"
			)
				return true;
			const typed =
				decodePrintableKey(data) !== undefined ||
				/^[^\x00-\x1f\x7f]+$/.test(data) ||
				(data.startsWith("\x1b[200~") && data.length > "\x1b[200~\x1b[201~".length);
			if (typed || keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down")) {
				this.enterArmed = true;
				this.notice.setText("");
			}
		}
		this.decision.handleInput(data);
		return true;
	}
}

function createStartupTui(settingsManager: SettingsManager): TUI {
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	initTheme(settingsManager.getTheme());
	setKeybindings(KeybindingsManager.create());
	const ui = new TuiMainScreen(new ProcessTerminal(), settingsManager.getShowHardwareCursor(), getAgentDir());
	ui.setClearOnShrink(settingsManager.getClearOnShrink());
	return ui;
}

async function clearStartupTui(ui: TUI): Promise<void> {
	ui.clear();
	ui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * Detect terminal appearance for first-run setup using one shared color query.
 * The terminal's background and foreground decide the result; unsupported
 * queries fall back to COLORFGBG and then dark.
 */
export async function detectStartupTheme(ui: TUI): Promise<TerminalTheme> {
	return detectTerminalThemeForAuto({ ui, timeoutMs: 100 });
}

export async function showFirstTimeSetup(settingsManager: SettingsManager): Promise<void> {
	return withEarlyInputHeldForStartupDialog(({ hasUnfinishedInput }) =>
		openFirstTimeSetup(settingsManager, hasUnfinishedInput),
	);
}

function openFirstTimeSetup(settingsManager: SettingsManager, hasUnfinishedInput: boolean): Promise<void> {
	const ui = createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: FirstTimeSetupResult | undefined) => {
			if (settled) return;
			settled = true;
			if (result) {
				settingsManager.setTheme(result.theme);
				settingsManager.setEnableAnalytics(result.shareAnalytics);
				await settingsManager.flush();
			}
			await clearStartupTui(ui);
			ui.stop();
			guarded.dispose();
			resolve();
		};
		const guarded = new TrustDecisionSelector(
			{ render: () => [], invalidate: () => {}, handleInput: () => {} },
			keepStartupDialogDraft,
			STARTUP_DECISION_TYPED_TEXT_NOTICE,
			{ enterArmed: !hasUnfinishedInput },
		);
		ui.addChild(guarded);
		ui.setFocus(guarded);
		void (async () => {
			ui.start();
			const detectedTheme = await detectStartupTheme(ui);
			setTheme(detectedTheme);
			const setup = new FirstTimeSetupComponent({
				detectedTheme,
				onThemePreview: (name) => {
					setTheme(name);
					ui.requestRender();
				},
				onSubmit: (result) => {
					void finish(result);
				},
				onCancel: () => {
					void finish(undefined);
				},
			});
			guarded.setDecision(setup);
			ui.requestRender();
		})();
	});
}

export async function showStartupSelector<T>(
	settingsManager: SettingsManager,
	title: string,
	options: Array<{ label: string; value: T }>,
	dialogOptions?: ExtensionUIDialogOptions,
): Promise<T | undefined> {
	return withEarlyInputHeldForStartupDialog(({ hasUnfinishedInput }) =>
		openStartupSelector(settingsManager, title, options, hasUnfinishedInput, dialogOptions),
	);
}

function openStartupSelector<T>(
	settingsManager: SettingsManager,
	title: string,
	options: Array<{ label: string; value: T }>,
	hasUnfinishedInput: boolean,
	dialogOptions?: ExtensionUIDialogOptions,
): Promise<T | undefined> {
	return new Promise((resolve) => {
		if (dialogOptions?.signal?.aborted) {
			resolve(undefined);
			return;
		}
		const ui = createStartupTui(settingsManager);

		let settled = false;
		const finish = async (result: T | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			dialogOptions?.signal?.removeEventListener("abort", abandon);
			await clearStartupTui(ui);
			ui.stop();
			selector.dispose();
			resolve(result);
		};
		const abandon = () => void finish(undefined);
		dialogOptions?.signal?.addEventListener("abort", abandon, { once: true });

		const labels = options.map((option) => option.label);
		const selector = new TrustDecisionSelector(
			new ExtensionSelectorComponent(
				title,
				labels,
				(option) => void finish(options.find((entry) => entry.label === option)?.value),
				() => void finish(undefined),
				{ tui: ui, timeout: dialogOptions?.timeout, initialIndex: safeTrustChoiceIndex(labels) },
			),
			keepStartupDialogDraft,
			isTrustDecision(labels) ? undefined : STARTUP_DECISION_TYPED_TEXT_NOTICE,
			{ enterArmed: !hasUnfinishedInput },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		ui.start();
	});
}

export async function showStartupInput(
	settingsManager: SettingsManager,
	title: string,
	placeholder?: string,
	dialogOptions?: ExtensionUIDialogOptions,
): Promise<string | undefined> {
	return withEarlyInputHeldForStartupDialog(({ hasUnfinishedInput }) =>
		openStartupInput(settingsManager, title, hasUnfinishedInput, placeholder, dialogOptions),
	);
}

function openStartupInput(
	settingsManager: SettingsManager,
	title: string,
	hasUnfinishedInput: boolean,
	placeholder?: string,
	dialogOptions?: ExtensionUIDialogOptions,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		if (dialogOptions?.signal?.aborted) {
			resolve(undefined);
			return;
		}
		const ui = createStartupTui(settingsManager);

		let settled = false;
		const finish = async (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			dialogOptions?.signal?.removeEventListener("abort", abandon);
			if (result === undefined) keepStartupDialogDraft(input.getValue());
			input.dispose();
			const trailingInput = new TrustDecisionSelector(
				{ render: () => [], invalidate: () => {}, handleInput: () => {} },
				keepStartupDialogDraft,
				STARTUP_DECISION_TYPED_TEXT_NOTICE,
			);
			ui.setFocus(trailingInput);
			await clearStartupTui(ui);
			ui.stop();
			trailingInput.dispose();
			resolve(result);
		};
		const abandon = () => void finish(undefined);
		dialogOptions?.signal?.addEventListener("abort", abandon, { once: true });

		const input = new ExtensionInputComponent(
			title,
			placeholder,
			(value) => void finish(value),
			() => void finish(undefined),
			{ tui: ui, timeout: dialogOptions?.timeout },
		);
		const guardedInput = new StartupDialogInputGuard(
			input,
			hasUnfinishedInput,
			"Type your answer and press Enter; your earlier text is kept as a draft.",
		);
		ui.addChild(guardedInput);
		ui.setFocus(guardedInput);
		ui.start();
	});
}
