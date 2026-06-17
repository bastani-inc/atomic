import { Container, type SelectItem, SelectList, type SelectListLayoutOptions } from "@earendil-works/pi-tui";
import { formatContextWindow } from "../../../core/context-window.ts";
import { getSelectListTheme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const CONTEXT_WINDOW_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

export interface ContextWindowSelectOptions {
	options: SelectItem[];
	currentValue: string;
	currentLabel: string;
	valueToContextWindow: Map<string, number>;
	labelByValue: Map<string, string>;
}

/**
 * Build the selectable context-window options for a model. Raw token counts are
 * used as stable option values so colliding compact display labels (for example
 * two windows that both render as `1.0m`) remain distinct and selectable.
 */
export function buildContextWindowSelectOptions(
	availableContextWindows: readonly number[],
	currentContextWindow: number,
): ContextWindowSelectOptions {
	const uniqueContextWindows = Array.from(new Set(availableContextWindows));
	const displayLabelCounts = new Map<string, number>();
	for (const contextWindow of uniqueContextWindows) {
		const displayLabel = formatContextWindow(contextWindow);
		displayLabelCounts.set(displayLabel, (displayLabelCounts.get(displayLabel) ?? 0) + 1);
	}

	const valueToContextWindow = new Map<string, number>();
	const labelByValue = new Map<string, string>();
	const options = uniqueContextWindows.map((contextWindow) => {
		const value = String(contextWindow);
		const displayLabel = formatContextWindow(contextWindow);
		const label =
			(displayLabelCounts.get(displayLabel) ?? 0) > 1 ? `${displayLabel} (${contextWindow} tokens)` : displayLabel;
		const option: SelectItem = { value, label };
		if (contextWindow === currentContextWindow) {
			option.description = "current";
		}
		valueToContextWindow.set(value, contextWindow);
		labelByValue.set(value, label);
		return option;
	});

	const currentValue = String(currentContextWindow);
	return {
		options,
		currentValue,
		currentLabel: labelByValue.get(currentValue) ?? formatContextWindow(currentContextWindow),
		valueToContextWindow,
		labelByValue,
	};
}

/**
 * Standalone selector for a model's context window. Surfaced as a follow-up step
 * in the `/model` flow for models that expose more than one selectable window
 * (for example GitHub Copilot long-context models). Selection is independent of
 * the thinking/reasoning level.
 */
export class ContextWindowSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(
		availableContextWindows: readonly number[],
		currentContextWindow: number,
		onSelect: (contextWindow: number) => void,
		onCancel: () => void,
	) {
		super();

		const choices = buildContextWindowSelectOptions(availableContextWindows, currentContextWindow);

		// Add top border
		this.addChild(new DynamicBorder());

		// Create selector
		this.selectList = new SelectList(
			choices.options,
			choices.options.length,
			getSelectListTheme(),
			CONTEXT_WINDOW_SELECT_LIST_LAYOUT,
		);

		// Preselect the current window
		const currentIndex = choices.options.findIndex((item) => item.value === choices.currentValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			const contextWindow = choices.valueToContextWindow.get(item.value);
			if (contextWindow !== undefined) {
				onSelect(contextWindow);
			} else {
				onCancel();
			}
		};

		this.selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.selectList);

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
