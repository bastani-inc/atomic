import {
	Editor,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import type {
	HostInputFormField,
	HostInputFormRequest,
} from "../../../core/extensions/ui-types.ts";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { Theme } from "../theme/theme.ts";
import { getEditorTheme } from "../theme/theme.ts";

export interface HostInputFormDelegate {
	onSubmit(values: Record<string, string>): void;
	onCancel(): void;
}

type Editable = Input | Editor;

function isEditable(field: HostInputFormField): boolean {
	return field.type !== "select" && field.type !== "boolean";
}

/** Host-owned form: all key handling and mutable editing state stay in the terminal process. */
export class HostInputFormComponent implements Component, Focusable {
	private readonly title: string;
	private readonly fields: HostInputFormField[];
	private readonly values: string[];
	private readonly editors: Array<Editable | undefined>;
	private readonly keybindings: KeybindingsManager;
	private readonly theme: Theme;
	private readonly tui: TUI;
	private readonly delegate: HostInputFormDelegate;
	private focusedIndex: number;
	private invalid = new Set<number>();
	private _focused = true;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		request: HostInputFormRequest,
		delegate: HostInputFormDelegate,
	) {
		this.title = request.title;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.delegate = delegate;
		this.fields = request.fields.map((field) => ({ ...field, choices: field.choices ? [...field.choices] : undefined }));
		this.values = this.fields.map((field) => field.initialValue);
		this.editors = this.fields.map((field, index) => {
			if (!isEditable(field)) return undefined;
			if (field.type === "text") {
				const editor = new Editor(tui, getEditorTheme(), { paddingX: 0 });
				editor.setText(field.initialValue);
				editor.onChange = (text) => { this.values[index] = text; };
				editor.disableSubmit = true;
				return editor;
			}
			const input = new Input();
			input.setValue(field.initialValue);
			Reflect.set(input, "cursor", field.initialValue.length);
			input.onSubmit = () => this.moveFocus(1);
			input.onEscape = () => this.delegate.onCancel();
			return input;
		});
		const firstInvalid = this.fields.findIndex((field, index) => this.invalidReason(field, this.values[index]!) !== undefined);
		this.focusedIndex = firstInvalid >= 0 ? firstInvalid : 0;
		this.syncFocus();
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.syncFocus(); }

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c")) ||
			this.keybindings.matches(data, "tui.select.cancel")
		) {
			this.delegate.onCancel();
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) { this.moveFocus(-1); return; }
		if (matchesKey(data, Key.tab) || this.keybindings.matches(data, "tui.input.tab")) { this.moveFocus(1); return; }
		if (this.focusedIndex === this.fields.length) { this.handleSubmitRow(data); return; }
		const field = this.fields[this.focusedIndex];
		if (!field) return;
		if (field.type === "select") this.handleSelect(data, field);
		else if (field.type === "boolean") this.handleBoolean(data);
		else this.handleEditable(data, field);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const lines = [
			this.fit(this.theme.fg("accent", this.theme.bold("WORKFLOW INPUTS")) + this.theme.fg("dim", `  ${this.title} · ${this.fields.length} fields`), safeWidth),
			"",
		];
		for (let index = 0; index < this.fields.length; index += 1) {
			const field = this.fields[index]!;
			const active = index === this.focusedIndex;
			const marker = active ? this.theme.fg("accent", "›") : " ";
			const required = field.required ? this.theme.fg("warning", "required") : this.theme.fg("dim", "optional");
			lines.push(this.fit(`${marker} ${active ? this.theme.fg("accent", field.name) : field.name}  ${required}`, safeWidth));
			lines.push(...this.renderField(field, index, Math.max(1, safeWidth - 2)).map((line) => this.fit(`  ${line}`, safeWidth)));
			if (field.description) lines.push(...wrapTextWithAnsi(this.theme.fg("dim", field.description), Math.max(1, safeWidth - 2)).map((line) => this.fit(`  ${line}`, safeWidth)));
			if (this.invalid.has(index)) lines.push(this.fit(`  ${this.theme.fg("error", this.invalidReason(field, this.currentValue(index)) ?? "invalid")}`, safeWidth));
			lines.push("");
		}
		const submit = this.focusedIndex === this.fields.length
			? this.theme.bg("selectedBg", this.theme.fg("accent", " Run workflow "))
			: this.theme.fg("dim", " Run workflow ");
		lines.push(this.fit(submit, safeWidth));
		lines.push(this.fit(this.theme.fg("dim", "Tab navigate · Enter continue/run · Esc cancel"), safeWidth));
		return lines;
	}

	invalidate(): void { for (const editor of this.editors) editor?.invalidate(); }

	private renderField(field: HostInputFormField, index: number, width: number): string[] {
		if (field.type === "select") {
			const current = this.values[index];
			return (field.choices ?? []).map((choice) => `${choice === current ? this.theme.fg("accent", "●") : this.theme.fg("dim", "○")} ${choice}`);
		}
		if (field.type === "boolean") {
			return [this.values[index] === "true" ? this.theme.fg("accent", "● on") : "○ on", this.values[index] === "false" ? this.theme.fg("accent", "● off") : "○ off"];
		}
		const editor = this.editors[index];
		if (!editor) return [""];
		const rendered = editor.render(width);
		if (this.currentValue(index) === "" && field.placeholder && this.focusedIndex !== index) return [this.theme.fg("dim", field.placeholder)];
		return rendered.length > 0 ? rendered : [""];
	}

	private handleEditable(data: string, field: HostInputFormField): void {
		const fieldIndex = this.focusedIndex;
		const editor = this.editors[fieldIndex];
		if (!editor) return;
		const verticalDirection = this.keybindings.matches(data, "tui.editor.cursorUp")
			? -1
			: this.keybindings.matches(data, "tui.editor.cursorDown")
				? 1
				: 0;
		if (verticalDirection !== 0) {
			if (field.type !== "text" || !(editor instanceof Editor)) {
				this.moveFocus(verticalDirection);
				return;
			}
			const before = editor.getCursor();
			editor.handleInput(data);
			const after = editor.getCursor();
			if (after.line === before.line && after.col === before.col) this.moveFocus(verticalDirection);
			return;
		}
		const continues = this.keybindings.matches(data, "tui.input.submit") ||
			this.keybindings.matches(data, "tui.input.newLine");
		if (continues) {
			if (field.type === "text" && editor instanceof Editor) {
				editor.insertTextAtCursor("\n");
				this.values[fieldIndex] = editor.getExpandedText();
			} else {
				this.moveFocus(1);
			}
			return;
		}
		editor.handleInput(data);
		this.values[fieldIndex] = editor instanceof Input ? editor.getValue() : editor.getExpandedText();
	}

	private handleSelect(data: string, field: HostInputFormField): void {
		const choices = field.choices ?? [];
		if (choices.length === 0) return;
		const current = Math.max(0, choices.indexOf(this.currentValue(this.focusedIndex)));
		if (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.editor.cursorLeft")) this.values[this.focusedIndex] = choices[(current - 1 + choices.length) % choices.length]!;
		else if (this.keybindings.matches(data, "tui.select.down") || this.keybindings.matches(data, "tui.editor.cursorRight") || matchesKey(data, Key.space)) this.values[this.focusedIndex] = choices[(current + 1) % choices.length]!;
		else if (this.keybindings.matches(data, "tui.select.confirm") || this.keybindings.matches(data, "tui.input.submit")) this.moveFocus(1);
	}

	private handleBoolean(data: string): void {
		if (matchesKey(data, Key.space) || this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.down") || this.keybindings.matches(data, "tui.editor.cursorLeft") || this.keybindings.matches(data, "tui.editor.cursorRight")) this.values[this.focusedIndex] = this.currentValue(this.focusedIndex) === "true" ? "false" : "true";
		else if (this.keybindings.matches(data, "tui.select.confirm") || this.keybindings.matches(data, "tui.input.submit")) this.moveFocus(1);
	}

	private handleSubmitRow(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.editor.cursorUp")) { this.moveFocus(-1); return; }
		if (this.keybindings.matches(data, "tui.select.down") || this.keybindings.matches(data, "tui.editor.cursorDown")) { this.moveFocus(1); return; }
		if (matchesKey(data, Key.enter) || this.keybindings.matches(data, "tui.select.confirm") || this.keybindings.matches(data, "tui.input.submit")) this.submit();
	}

	private submit(): void {
		this.invalid = new Set<number>();
		for (let index = 0; index < this.fields.length; index += 1) if (this.invalidReason(this.fields[index]!, this.currentValue(index))) this.invalid.add(index);
		if (this.invalid.size > 0) { this.focusedIndex = this.invalid.values().next().value ?? 0; this.syncFocus(); this.tui.requestRender(); return; }
		const values: Record<string, string> = Object.fromEntries(
			this.fields.map((field, index) => [field.name, this.currentValue(index)]),
		);
		this.delegate.onSubmit(values);
	}

	private invalidReason(field: HostInputFormField, value: string): string | undefined {
		if (field.required && value.trim() === "") return "required";
		if (field.type === "select" && value !== "" && !(field.choices ?? []).includes(value)) return "not in choices";
		if ((field.type === "number" || field.type === "integer") && value !== "" && !Number.isFinite(Number(value))) return "must be a number";
		return undefined;
	}

	private moveFocus(delta: number): void {
		const count = this.fields.length + 1;
		if (count <= 1) return;
		this.focusedIndex = (this.focusedIndex + delta + count) % count;
		this.syncFocus();
		this.tui.requestRender();
	}
	private syncFocus(): void { this.editors.forEach((editor, index) => { if (editor) editor.focused = this._focused && index === this.focusedIndex; }); }
	private currentValue(index: number): string { const editor = this.editors[index]; return editor instanceof Input ? editor.getValue() : editor instanceof Editor ? editor.getExpandedText() : this.values[index] ?? ""; }
	private fit(line: string, width: number): string { const clipped = truncateToWidth(line, width, "…"); return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))); }
}
