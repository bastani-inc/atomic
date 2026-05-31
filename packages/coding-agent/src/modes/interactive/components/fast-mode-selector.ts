import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export interface FastModeSelectorConfig {
	chat: boolean;
	workflow: boolean;
}

export interface FastModeSelectorCallbacks {
	onChange: (settings: FastModeSelectorConfig, changedRow: FastModeRow) => void;
	onCancel: () => void | Promise<void>;
}

export type FastModeRow = keyof FastModeSelectorConfig;

const ROWS: readonly FastModeRow[] = ["chat", "workflow"];
const DESCRIPTION = "Uses OpenAI priority service tier for supported openai/* and openai-codex/* models.";

export class FastModeSelectorComponent {
	private selectedRowIndex = 0;
	private state: FastModeSelectorConfig;
	private readonly callbacks: FastModeSelectorCallbacks;

	constructor(config: FastModeSelectorConfig, callbacks: FastModeSelectorCallbacks) {
		this.state = { ...config };
		this.callbacks = callbacks;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [theme.bold(theme.fg("accent", "Codex fast mode")), ""];
		for (const line of wrapTextWithAnsi(DESCRIPTION, Math.max(20, width))) {
			lines.push(theme.fg("muted", line));
		}
		lines.push("");
		for (const row of ROWS) {
			lines.push(this.renderRow(row, width));
		}
		lines.push("");
		lines.push(truncateToWidth(theme.fg("dim", "tab/↑↓ row · ← enable · → disable · esc close"), width));
		return lines.map((line) => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "tab") || matchesKey(data, "down")) {
			this.moveRow(1);
			return;
		}
		if (matchesKey(data, "shift+tab") || matchesKey(data, "up")) {
			this.moveRow(-1);
			return;
		}
		if (matchesKey(data, "left")) {
			this.setCurrentRow(true);
			return;
		}
		if (matchesKey(data, "right")) {
			this.setCurrentRow(false);
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			void this.callbacks.onCancel();
		}
	}

	getFocusedRow(): FastModeRow {
		return ROWS[this.selectedRowIndex]!;
	}

	getSettings(): FastModeSelectorConfig {
		return { ...this.state };
	}

	private moveRow(delta: 1 | -1): void {
		this.selectedRowIndex = (this.selectedRowIndex + delta + ROWS.length) % ROWS.length;
	}

	private setCurrentRow(enabled: boolean): void {
		const row = this.getFocusedRow();
		if (this.state[row] === enabled) {
			return;
		}
		this.state = { ...this.state, [row]: enabled };
		this.callbacks.onChange({ ...this.state }, row);
	}

	private renderRow(row: FastModeRow, width: number): string {
		const selected = this.getFocusedRow() === row;
		const prefix = selected ? theme.fg("accent", "› ") : "  ";
		const label = row.padEnd(8, " ");
		const labelText = selected ? theme.bold(theme.fg("accent", label)) : theme.fg("text", label);
		const enabledText = this.renderValue(row, true);
		const disabledText = this.renderValue(row, false);
		return truncateToWidth(`${prefix}${labelText}  ${enabledText} ${disabledText}`, width);
	}

	private renderValue(row: FastModeRow, enabled: boolean): string {
		const value = enabled ? "enabled" : "disabled";
		const selected = this.getFocusedRow() === row;
		const active = this.state[row] === enabled;
		const text = active ? `[${value}]` : ` ${value} `;
		if (selected && active) {
			return theme.bold(theme.fg("accent", text));
		}
		if (active) {
			return theme.fg("text", text);
		}
		return theme.fg("dim", text);
	}
}
