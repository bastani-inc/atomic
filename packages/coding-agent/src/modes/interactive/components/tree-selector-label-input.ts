import { type Component, type Focusable, getKeybindings, Input, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

/** Label input component shown when editing a label */
export class LabelInput implements Component, Focusable {
	private input: Input;
	private entryId: string;
	public onSubmit?: (entryId: string, label: string | undefined) => void;
	public onCancel?: () => void;

	// Focusable implementation - propagate to input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(entryId: string, currentLabel: string | undefined) {
		this.entryId = entryId;
		this.input = new Input();
		if (currentLabel) {
			this.input.setValue(currentLabel);
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const indent = "  ";
		const availableWidth = width - indent.length;
		lines.push(truncateToWidth(`${indent}${theme.fg("muted", "Label (empty to remove):")}`, width));
		lines.push(...this.input.render(availableWidth).map((line) => truncateToWidth(`${indent}${line}`, width)));
		lines.push(
			truncateToWidth(
				`${indent}${keyHint("tui.select.confirm", "save")}  ${keyHint("tui.select.cancel", "cancel")}`,
				width,
			),
		);
		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm")) {
			const value = this.input.getValue().trim();
			this.onSubmit?.(this.entryId, value || undefined);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel?.();
		} else {
			this.input.handleInput(keyData);
		}
	}
}
