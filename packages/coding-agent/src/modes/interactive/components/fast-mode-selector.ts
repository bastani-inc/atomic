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
const LABEL_WIDTH = 16;
const DESCRIPTION = "Priority tier for supported openai/* and openai-codex/* models.";
const ROW_DETAILS: Record<FastModeRow, { label: string; scope: string }> = {
	chat: {
		label: "Chat",
		scope: "this chat + subagents",
	},
	workflow: {
		label: "Workflow stages",
		scope: "workflow stages",
	},
};

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
		const lines: string[] = [truncateToWidth(theme.bold(theme.fg("accent", "Codex fast mode")), width)];
		for (const line of wrapTextWithAnsi(DESCRIPTION, Math.max(20, width))) {
			lines.push(theme.fg("muted", line));
		}
		lines.push("");
		for (const row of ROWS) {
			lines.push(this.renderRow(row, width));
		}
		lines.push("");
		lines.push(truncateToWidth(this.renderHint(), width));
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
		if (matchesKey(data, "enter") || data === " ") {
			this.toggleCurrentRow();
			return;
		}
		if (matchesKey(data, "left")) {
			this.setCurrentRow(false);
			return;
		}
		if (matchesKey(data, "right")) {
			this.setCurrentRow(true);
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

	private toggleCurrentRow(): void {
		const row = this.getFocusedRow();
		this.setCurrentRow(!this.state[row]);
	}

	private renderHint(): string {
		const sep = theme.fg("dim", " · ");
		const hint = (key: string, label: string): string => theme.fg("dim", key) + theme.fg("muted", ` ${label}`);
		return [hint("↑↓/tab", "row"), hint("space/enter", "toggle"), hint("esc", "close")].join(sep);
	}

	private renderRow(row: FastModeRow, width: number): string {
		const selected = this.getFocusedRow() === row;
		const detail = ROW_DETAILS[row];
		const prefix = selected ? theme.fg("accent", "› ") : "  ";
		const label = detail.label.padEnd(LABEL_WIDTH, " ");
		const labelText = selected ? theme.bold(theme.fg("accent", label)) : theme.fg("text", label);
		const scope = selected ? theme.fg("muted", detail.scope) : theme.fg("dim", detail.scope);
		return truncateToWidth(`${prefix}${labelText} ${this.renderToggle(row)}  ${scope}`, width);
	}

	private renderToggle(row: FastModeRow): string {
		const enabled = this.state[row];
		const text = enabled ? "[● ON ]" : "[○ OFF]";
		if (enabled) {
			return theme.bold(theme.fg("success", text));
		}
		return this.getFocusedRow() === row ? theme.fg("muted", text) : theme.fg("dim", text);
	}
}
