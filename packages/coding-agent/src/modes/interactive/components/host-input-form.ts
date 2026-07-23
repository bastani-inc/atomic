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

/** Indent (cells) for a field's control, description, and error rows so they align under the field name. */
const LABEL_INDENT = 2;

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
	private readonly heading: string;
	private readonly submitLabel: string;
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
		this.heading = request.heading ?? "";
		this.submitLabel = request.submitLabel ?? "[ Submit ]";
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.delegate = delegate;
		this.fields = request.fields.map((field) => ({ ...field, choices: field.choices ? [...field.choices] : undefined }));
		this.values = this.fields.map((field) => field.initialValue);
		this.editors = this.fields.map((field, index) => {
			if (!isEditable(field)) return undefined;
			if (field.type === "text") {
				// Quiet the multi-line editor's top/bottom rules to the panel border tone
				// so the inset text area blends with the form frame instead of shouting.
				const editorTheme = { ...getEditorTheme(), borderColor: (segment: string) => theme.fg("border", segment) };
				const editor = new Editor(tui, editorTheme, { paddingX: 0 });
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
		const boxWidth = Math.max(1, width);
		const inner = Math.max(2, boxWidth - 2);
		const cw = Math.max(8, inner - 2);
		const controlWidth = Math.max(1, cw - LABEL_INDENT);
		const indent = " ".repeat(LABEL_INDENT);
		const body: string[] = [];

		const fieldCount = `${this.fields.length} ${this.fields.length === 1 ? "field" : "fields"}`;
		const nameBudget = Math.max(4, cw - fieldCount.length - 5);
		body.push(
			this.theme.bold(this.theme.fg("text", truncateToWidth(this.title, nameBudget, "…"))) +
				this.theme.fg("dim", `  ·  ${fieldCount}`),
		);
		body.push("");

		for (let index = 0; index < this.fields.length; index += 1) {
			const field = this.fields[index]!;
			const active = index === this.focusedIndex;
			body.push(this.labelRow(field, active, cw));
			for (const line of this.renderField(field, index, controlWidth)) body.push(`${indent}${line}`);
			if (field.description) {
				for (const line of wrapTextWithAnsi(this.theme.fg("muted", field.description), Math.max(1, cw - LABEL_INDENT))) {
					body.push(`${indent}${line}`);
				}
			}
			if (this.invalid.has(index)) {
				body.push(`${indent}${this.theme.fg("error", `✗ ${this.invalidReason(field, this.currentValue(index)) ?? "invalid"}`)}`);
			}
			body.push("");
		}

		body.push(this.submitRow());
		body.push("");
		body.push(this.footerRow());

		return this.frame(body, inner, cw);
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
	/** Field header: focus chevron + name (accent when active) with a right-aligned required/optional badge. */
	private labelRow(field: HostInputFormField, active: boolean, cw: number): string {
		const badgePlain = field.required ? "required" : "optional";
		const marker = active ? this.theme.fg("accent", "▸") : " ";
		const nameBudget = Math.max(4, cw - badgePlain.length - 3);
		const nameShown = truncateToWidth(field.name, nameBudget, "…");
		const nameStyled = active
			? this.theme.fg("accent", this.theme.bold(nameShown))
			: this.theme.fg("text", nameShown);
		const badge = field.required
			? this.theme.fg("warning", badgePlain)
			: this.theme.fg("dim", badgePlain);
		const gap = Math.max(1, cw - 2 - visibleWidth(nameShown) - badgePlain.length);
		return `${marker} ${nameStyled}${" ".repeat(gap)}${badge}`;
	}

	/** Submit control rendered as a button pill; filled accent when focused, quiet outline otherwise. */
	private submitRow(): string {
		const label = this.submitLabel;
		const active = this.focusedIndex === this.fields.length;
		const marker = active ? this.theme.fg("accent", "▸") : " ";
		const pill = active
			? this.theme.bg("selectedBg", this.theme.bold(this.theme.fg("accent", label)))
			: this.theme.fg("dim", label);
		return `${marker} ${pill}`;
	}

	/** Key-hint footer with accent key chips and muted verbs. */
	private footerRow(): string {
		const key = (k: string): string => this.theme.fg("accent", k);
		const dim = (t: string): string => this.theme.fg("dim", t);
		const sep = dim("  ·  ");
		return `${key("Tab")} ${dim("move")}${sep}${key("Enter")} ${dim("continue / run")}${sep}${key("Esc")} ${dim("cancel")}`;
	}

	/**
	 * Wrap the pre-built body rows in a rounded panel. The title rides the top
	 * border; each row gets one cell of interior padding on both sides. Rows are
	 * padded (not truncated) unless they overflow, so an embedded editor's inline
	 * cursor marker is never clipped away.
	 */
	private frame(body: readonly string[], inner: number, cw: number): string[] {
		const border = (glyph: string): string => this.theme.fg("border", glyph);
		const title = this.heading ? ` ${this.theme.fg("accent", this.theme.bold(this.heading))} ` : "";
		const top = `${border("╭")}${title}${border("─".repeat(Math.max(0, inner - visibleWidth(title))))}${border("╮")}`;
		const rows = body.map((line) => {
			const clipped = visibleWidth(line) > cw ? truncateToWidth(line, cw, "…") : line;
			const pad = " ".repeat(Math.max(0, cw - visibleWidth(clipped)));
			return `${border("│")} ${clipped}${pad} ${border("│")}`;
		});
		const bottom = `${border("╰")}${border("─".repeat(inner))}${border("╯")}`;
		return [top, ...rows, bottom];
	}
}
