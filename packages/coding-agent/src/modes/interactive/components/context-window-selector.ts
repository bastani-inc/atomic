import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

/** Gap (in columns) between the label column and the right-hand token column. */
const TOKEN_COLUMN_GAP = 3;

export interface ContextWindowChoice {
	/** Raw token count; the stable identity for this choice. */
	contextWindow: number;
	/** `String(contextWindow)` — stable selection value, independent of display label. */
	value: string;
	/** Semantic tier label, e.g. "Default" / "Long context" (falls back to a size for extra tiers). */
	label: string;
	/** True for the model's native (smallest) window, rendered with a `(default)` tag. */
	isDefault: boolean;
	/** Right-column display, e.g. "400K tokens" / "1M tokens". */
	tokensLabel: string;
}

export interface ContextWindowChoices {
	choices: ContextWindowChoice[];
	currentIndex: number;
}

/**
 * Format a token count the way the GitHub Copilot CLI does: `400K`, `1M`, `1.1M`.
 * Sub-million values render in thousands (`264K`), millions render with one decimal
 * unless whole (`1M`, not `1.0M`). A model reporting ~1,050,000 rounds to `1.1M`.
 */
export function formatContextSize(tokens: number): string {
	if (tokens >= 1_000_000) {
		const millions = tokens / 1_000_000;
		return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`;
	}
	return `${Math.round(tokens / 1_000).toLocaleString()}K`;
}

/**
 * Build the ordered, deduped context-window choices for the picker. The smallest
 * window is the model's native default ("Default"), the largest is "Long context",
 * and any extra tiers fall back to their formatted size. Raw token counts remain the
 * stable identity so colliding display labels never affect selection.
 */
export function buildContextWindowChoices(
	availableContextWindows: readonly number[],
	currentContextWindow: number,
): ContextWindowChoices {
	const sorted = Array.from(new Set(availableContextWindows)).sort((a, b) => a - b);
	const smallest = sorted[0];
	const largest = sorted[sorted.length - 1];

	const choices = sorted.map((contextWindow): ContextWindowChoice => {
		let label: string;
		if (contextWindow === smallest) {
			label = "Default";
		} else if (contextWindow === largest) {
			label = "Long context";
		} else {
			label = formatContextSize(contextWindow);
		}
		return {
			contextWindow,
			value: String(contextWindow),
			label,
			isDefault: contextWindow === smallest,
			tokensLabel: `${formatContextSize(contextWindow)} tokens`,
		};
	});

	const currentIndex = sorted.indexOf(currentContextWindow);
	return { choices, currentIndex: currentIndex >= 0 ? currentIndex : 0 };
}

/**
 * Faithful re-creation of the GitHub Copilot CLI context-window picker, surfaced as a
 * follow-up step in the `/model` flow for models that expose more than one window.
 *
 * Renders numbered rows with a `❯` caret, semantic tier labels, a dim `(default)` tag,
 * and right-aligned dim token counts:
 *
 * ```
 * Select Context Window for GPT-5.5
 *
 *    1. Default (default)   400K tokens
 *  ❯ 2. Long context        1M tokens
 *
 *  1-2 select · up/down navigate · enter confirm · esc cancel
 * ```
 */
export class ContextWindowSelectorComponent extends Container {
	private readonly choices: ContextWindowChoice[];
	private readonly listContainer: Container;
	private selectedIndex: number;
	private readonly onSelectCallback: (contextWindow: number) => void;
	private readonly onCancelCallback: () => void;

	constructor(
		modelName: string,
		availableContextWindows: readonly number[],
		currentContextWindow: number,
		onSelect: (contextWindow: number) => void,
		onCancel: () => void,
	) {
		super();

		const { choices, currentIndex } = buildContextWindowChoices(availableContextWindows, currentContextWindow);
		this.choices = choices;
		this.selectedIndex = currentIndex;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", `Select Context Window for ${modelName}`), 0, 0));
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));
		this.addChild(new Text(this.getHintBar(), 0, 0));
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	private getHintBar(): string {
		const separator = theme.fg("muted", "  ·  ");
		return [
			rawKeyHint(`1-${this.choices.length}`, "select"),
			rawKeyHint("up/down", "navigate"),
			keyHint("tui.select.confirm", "confirm"),
			keyHint("tui.select.cancel", "cancel"),
		].join(separator);
	}

	private updateList(): void {
		this.listContainer.clear();

		const numberColumnWidth = `${this.choices.length}.`.length;
		const leftText = (choice: ContextWindowChoice, index: number): string => {
			const number = `${index + 1}.`.padStart(numberColumnWidth);
			const defaultTag = choice.isDefault ? " (default)" : "";
			return `${number} ${choice.label}${defaultTag}`;
		};
		const leftColumnWidth = Math.max(...this.choices.map((choice, index) => leftText(choice, index).length));

		this.choices.forEach((choice, index) => {
			const isSelected = index === this.selectedIndex;
			const caret = isSelected ? theme.fg("accent", "❯ ") : "  ";
			const number = theme.fg("muted", `${`${index + 1}.`.padStart(numberColumnWidth)} `);
			const label = isSelected ? theme.fg("accent", choice.label) : choice.label;
			const defaultTag = choice.isDefault ? theme.fg("muted", " (default)") : "";
			const padding = " ".repeat(leftColumnWidth - leftText(choice, index).length + TOKEN_COLUMN_GAP);
			const tokens = theme.fg("muted", choice.tokensLabel);
			this.listContainer.addChild(new Text(`${caret}${number}${label}${defaultTag}${padding}${tokens}`, 0, 0));
		});
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = this.selectedIndex === 0 ? this.choices.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = this.selectedIndex === this.choices.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			this.confirm(this.selectedIndex);
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}
		// Number shortcuts (1-9) select the matching row directly.
		if (/^[1-9]$/.test(keyData)) {
			this.confirm(Number.parseInt(keyData, 10) - 1);
		}
	}

	private confirm(index: number): void {
		const choice = this.choices[index];
		if (choice) {
			this.onSelectCallback(choice.contextWindow);
		}
	}
}
