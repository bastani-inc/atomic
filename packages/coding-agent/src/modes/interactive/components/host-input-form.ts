import {
	type Component,
	clickableKeysHint,
	Editor,
	type Focusable,
	Input,
	Key,
	type KeyId,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@bastani/atomic-tui";
import type { HostInputFormField, HostInputFormRequest } from "../../../core/extensions/ui-types.js";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { Theme } from "../theme/theme.js";
import { getEditorTheme } from "../theme/theme.js";

const LABEL_INDENT = 2;

export interface HostInputFormDelegate {
	onSubmit(values: Record<string, string>): void;
	onCancel(): void;
}

type Editable = Input | Editor;

const BOOLEAN_TEXT = new Set(["true", "false", "1", "0", "on", "off"]);

function isEditable(field: HostInputFormField): boolean {
	return field.type !== "select" && field.type !== "boolean";
}

function sanitizeDisplayText(value: string, tabWidth = 4): string {
	const stops = Math.max(1, Math.floor(tabWidth));
	let out = "";
	let column = 0;
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (char === "\n") {
			out += char;
			column = 0;
			continue;
		}
		if (char === "\t") {
			const pad = stops - (column % stops);
			out += " ".repeat(pad);
			column += pad;
			continue;
		}
		if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
			const escaped = `\\x${code.toString(16).padStart(2, "0")}`;
			out += escaped;
			column += escaped.length;
			continue;
		}
		out += char;
		column += 1;
	}
	return out;
}

function sanitizeSingleLine(value: string): string {
	return sanitizeDisplayText(value).replace(/\n/g, " ");
}

function rawColumn(line: string, displayColumn: number): number {
	let column = 0;
	let shown = 0;
	let stop = 0;
	for (const char of line) {
		const code = char.codePointAt(0) ?? 0;
		let width = char.length;
		let advance = 1;
		if (char === "\n") {
			advance = -stop;
		} else if (char === "\t") {
			width = 4 - (stop % 4);
			advance = width;
		} else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
			width = 4;
			advance = 4;
		}
		const next = shown + width;
		if (next > displayColumn) return displayColumn - shown <= next - displayColumn ? column : column + char.length;
		column += char.length;
		shown = next;
		stop += advance;
	}
	return column;
}

function stepRawColumn(line: string, column: number, direction: 1 | -1): number {
	if (direction > 0) {
		const code = line.codePointAt(column);
		return code === undefined ? column : column + (code > 0xffff ? 2 : 1);
	}
	if (column <= 0) return 0;
	const low = line.charCodeAt(column - 1);
	const high = column >= 2 ? line.charCodeAt(column - 2) : 0;
	return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? column - 2 : column - 1;
}

function withDisplayLines<T>(editor: Editor, action: () => T, keepCursor: boolean): T {
	const state = Reflect.get(editor, "state") as { lines: string[]; cursorLine: number; cursorCol: number };
	const savedLines = [...state.lines];
	const savedLine = state.cursorLine;
	const savedCol = state.cursorCol;
	const currentLineText = savedLines[savedLine] ?? "";
	const clampedCol = Math.max(0, Math.min(savedCol, currentLineText.length));
	state.lines = savedLines.map((line) => sanitizeSingleLine(line));
	state.cursorCol = sanitizeSingleLine(currentLineText.slice(0, clampedCol)).length;
	const startCol = state.cursorCol;
	try {
		return action();
	} finally {
		const movedLine = state.cursorLine;
		const movedCol = state.cursorCol;
		const movedText = savedLines[movedLine] ?? "";
		let column = keepCursor ? rawColumn(movedText, movedCol) : savedCol;
		if (keepCursor && movedLine === savedLine && movedCol !== startCol && column === savedCol) {
			column = stepRawColumn(movedText, savedCol, movedCol > startCol ? 1 : -1);
		}
		state.lines = savedLines;
		state.cursorLine = keepCursor ? movedLine : savedLine;
		state.cursorCol = column;
	}
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
	private readonly reasons: Array<{ value: string; reason: string | undefined } | undefined> = [];
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
		this.fields = request.fields.map((field) => ({
			...field,
			choices: field.choices ? [...field.choices] : undefined,
		}));
		this.values = this.fields.map((field) => field.initialValue);
		this.editors = this.fields.map((field, index) => {
			if (!isEditable(field)) return undefined;
			if (field.type === "text") {
				const editorTheme = { ...getEditorTheme(), borderColor: (segment: string) => theme.fg("border", segment) };
				const editor = new Editor(tui, editorTheme, { paddingX: 0 });
				editor.setText(field.initialValue);
				const initialLines = field.initialValue.split("\n");
				const lastLineIdx = Math.max(0, initialLines.length - 1);
				Reflect.set(editor, "state", {
					lines: initialLines,
					cursorLine: lastLineIdx,
					cursorCol: (initialLines[lastLineIdx] ?? "").length,
				});
				editor.onChange = () => {
					this.values[index] = editor.getExpandedText();
				};
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
		const firstInvalid = this.fields.findIndex(
			(_field, index) => this.invalidReason(index, this.currentValue(index)) !== undefined,
		);
		this.focusedIndex = firstInvalid >= 0 ? firstInvalid : 0;
		this.syncFocus();
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.syncFocus();
	}

	handleInput(data: string): boolean {
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c")) ||
			this.keybindings.matches(data, "tui.select.cancel")
		) {
			this.delegate.onCancel();
			return true;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.moveFocus(-1);
			return true;
		}
		if (matchesKey(data, Key.tab) || this.keybindings.matches(data, "tui.input.tab")) {
			this.moveFocus(1);
			return true;
		}
		if (this.focusedIndex === this.fields.length) {
			this.handleSubmitRow(data);
			return true;
		}
		const field = this.fields[this.focusedIndex];
		if (!field) return true;
		if (field.type === "select") this.handleSelect(data, field);
		else if (field.type === "boolean") this.handleBoolean(data);
		else this.handleEditable(data, field);
		this.tui.requestRender();
		return true;
	}

	render(width: number): string[] {
		const boxWidth = Math.max(1, Math.floor(width));
		const inner = Math.max(0, boxWidth - 2);
		const cw = Math.max(0, inner - 2);
		const controlWidth = Math.max(1, cw - LABEL_INDENT);
		const indent = " ".repeat(Math.min(LABEL_INDENT, cw));
		const body: string[] = [];

		const fieldCount = `${this.fields.length} ${this.fields.length === 1 ? "field" : "fields"}`;
		const safeTitle = sanitizeSingleLine(this.title);
		const nameBudget = Math.max(1, cw - fieldCount.length - 5);
		body.push(
			this.theme.bold(this.theme.fg("text", truncateToWidth(safeTitle, nameBudget, "…"))) +
				this.theme.fg("dim", `  ·  ${fieldCount}`),
		);
		body.push("");

		for (let index = 0; index < this.fields.length; index += 1) {
			const field = this.fields[index]!;
			const active = index === this.focusedIndex;
			const label = this.labelRow(field, index, active, cw);
			body.push(label.line);
			for (const line of this.renderField(field, index, controlWidth)) body.push(`${indent}${line}`);
			if (label.wrappedInvalid !== undefined) {
				const errColor = this.invalid.has(index) || !field.required ? "error" : "warning";
				for (const line of wrapTextWithAnsi(
					this.theme.fg(errColor, `✗ ${label.wrappedInvalid}`),
					Math.max(1, cw - indent.length),
				)) {
					body.push(`${indent}${line}`);
				}
			}
			if (field.description) {
				const safeDesc = sanitizeSingleLine(field.description);
				for (const line of wrapTextWithAnsi(this.theme.fg("muted", safeDesc), Math.max(1, cw - indent.length))) {
					body.push(`${indent}${line}`);
				}
			}
			body.push("");
		}

		body.push(this.submitRow());
		body.push("");
		body.push(this.footerRow());

		return this.frame(body, inner, cw, boxWidth);
	}

	invalidate(): void {
		for (const editor of this.editors) editor?.invalidate();
	}

	private renderField(field: HostInputFormField, index: number, width: number): string[] {
		if (field.type === "select") {
			const current = this.values[index];
			return (field.choices ?? []).map(
				(choice) =>
					`${choice === current ? this.theme.fg("accent", "●") : this.theme.fg("dim", "○")} ${sanitizeSingleLine(choice)}`,
			);
		}
		if (field.type === "boolean") {
			const value = (this.values[index] ?? "").trim().toLowerCase();
			const on = value === "true" || value === "1" || value === "on";
			const off = value === "false" || value === "0" || value === "off";
			return [on ? this.theme.fg("accent", "● on") : "○ on", off ? this.theme.fg("accent", "● off") : "○ off"];
		}
		const editor = this.editors[index];
		if (!editor) return [""];
		if (this.currentValue(index) === "" && field.placeholder && this.focusedIndex !== index)
			return [this.theme.fg("dim", sanitizeSingleLine(field.placeholder))];
		if (editor instanceof Input) {
			const rawValue = editor.getValue();
			const rawCursor = Math.max(0, Math.min(Reflect.get(editor, "cursor") as number, rawValue.length));
			const safeValue = sanitizeSingleLine(rawValue);
			const safeCursor = sanitizeSingleLine(rawValue.slice(0, rawCursor)).length;
			editor.setValue(safeValue);
			Reflect.set(editor, "cursor", safeCursor);
			try {
				const rendered = editor.render(width);
				return rendered.length > 0 ? rendered : [""];
			} finally {
				editor.setValue(rawValue);
				Reflect.set(editor, "cursor", rawCursor);
			}
		}
		const rendered = withDisplayLines(editor, () => editor.render(Math.max(3, width)), false);
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
			withDisplayLines(editor, () => editor.handleInput(data), true);
			const after = editor.getCursor();
			if (after.line === before.line && after.col === before.col) this.moveFocus(verticalDirection);
			return;
		}
		if (
			field.type === "text" &&
			editor instanceof Editor &&
			(this.keybindings.matches(data, "tui.editor.pageUp") || this.keybindings.matches(data, "tui.editor.pageDown"))
		) {
			withDisplayLines(editor, () => editor.handleInput(data), true);
			this.values[fieldIndex] = editor.getExpandedText();
			return;
		}
		const continues =
			this.keybindings.matches(data, "tui.input.submit") || this.keybindings.matches(data, "tui.input.newLine");
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
		const current = choices.indexOf(this.currentValue(this.focusedIndex));
		if (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.editor.cursorLeft"))
			this.values[this.focusedIndex] =
				choices[current < 0 ? choices.length - 1 : (current - 1 + choices.length) % choices.length]!;
		else if (
			this.keybindings.matches(data, "tui.select.down") ||
			this.keybindings.matches(data, "tui.editor.cursorRight") ||
			matchesKey(data, Key.space)
		)
			this.values[this.focusedIndex] = choices[(current + 1) % choices.length]!;
		else if (
			this.keybindings.matches(data, "tui.select.confirm") ||
			this.keybindings.matches(data, "tui.input.submit")
		)
			this.moveFocus(1);
	}

	private handleBoolean(data: string): void {
		if (
			matchesKey(data, Key.space) ||
			this.keybindings.matches(data, "tui.select.up") ||
			this.keybindings.matches(data, "tui.select.down") ||
			this.keybindings.matches(data, "tui.editor.cursorLeft") ||
			this.keybindings.matches(data, "tui.editor.cursorRight")
		)
			this.values[this.focusedIndex] = ["true", "1", "on"].includes(
				this.currentValue(this.focusedIndex).trim().toLowerCase(),
			)
				? "false"
				: "true";
		else if (
			this.keybindings.matches(data, "tui.select.confirm") ||
			this.keybindings.matches(data, "tui.input.submit")
		)
			this.moveFocus(1);
	}

	private handleSubmitRow(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.editor.cursorUp")) {
			this.moveFocus(-1);
			return;
		}
		if (
			this.keybindings.matches(data, "tui.select.down") ||
			this.keybindings.matches(data, "tui.editor.cursorDown")
		) {
			this.moveFocus(1);
			return;
		}
		if (
			matchesKey(data, Key.enter) ||
			this.keybindings.matches(data, "tui.select.confirm") ||
			this.keybindings.matches(data, "tui.input.submit")
		)
			this.submit();
	}

	private submit(): void {
		this.invalid = new Set<number>();
		for (let index = 0; index < this.fields.length; index += 1)
			if (this.invalidReason(index, this.currentValue(index))) this.invalid.add(index);
		if (this.invalid.size > 0) {
			this.focusedIndex = this.invalid.values().next().value ?? 0;
			this.syncFocus();
			this.tui.requestRender();
			return;
		}
		const values: Record<string, string> = Object.fromEntries(
			this.fields.map((field, index) => [field.name, this.currentValue(index)]),
		);
		this.delegate.onSubmit(values);
	}

	private invalidReason(index: number, value: string): string | undefined {
		const cached = this.reasons[index];
		if (cached?.value === value) return cached.reason;
		const reason = this.computeInvalidReason(this.fields[index]!, value);
		this.reasons[index] = { value, reason };
		return reason;
	}

	private computeInvalidReason(field: HostInputFormField, value: string): string | undefined {
		const empty = value.trim() === "";
		if (field.required && empty) {
			if (field.type === "select") return "choose one";
			if (field.type === "boolean") return "choose on or off";
			return "required";
		}
		if (empty) return undefined;
		if (field.type === "select") {
			return (field.choices ?? []).includes(value) ? undefined : "not in choices";
		}
		if (field.type === "boolean") {
			return BOOLEAN_TEXT.has(value.trim().toLowerCase()) ? undefined : "must be on or off";
		}
		if (field.type === "integer") {
			const n = Number(value);
			if (!Number.isInteger(n)) return "must be a whole number";
			return Number.isSafeInteger(n) ? undefined : `must be a whole number within ±${Number.MAX_SAFE_INTEGER}`;
		}
		if (field.type === "number") {
			return Number.isFinite(Number(value)) ? undefined : "must be a number";
		}
		return undefined;
	}

	private moveFocus(delta: number): void {
		const count = this.fields.length + 1;
		if (count <= 1) return;
		this.focusedIndex = (this.focusedIndex + delta + count) % count;
		this.syncFocus();
		this.tui.requestRender();
	}
	private syncFocus(): void {
		this.editors.forEach((editor, index) => {
			if (editor) editor.focused = this._focused && index === this.focusedIndex;
		});
	}
	private currentValue(index: number): string {
		return this.values[index] ?? "";
	}
	private labelRow(
		field: HostInputFormField,
		index: number,
		active: boolean,
		cw: number,
	): { line: string; wrappedInvalid?: string } {
		const safeName = sanitizeSingleLine(field.name);
		const invalid = this.invalidReason(index, this.currentValue(index));
		const safeInvalid = invalid !== undefined ? sanitizeSingleLine(invalid) : undefined;
		const requiredness = field.required ? "required" : "optional";
		const statusPlain = safeInvalid === undefined ? "✓" : `✗ ${safeInvalid}`;
		const rawPrefix = safeInvalid === "required" ? "" : `${requiredness} · `;
		const minNameCols = Math.min(visibleWidth(safeName), 4);
		const fullBadgePlain = `${rawPrefix}${statusPlain}`;
		let prefix = rawPrefix;
		let badgeStatusPlain = statusPlain;
		let wrappedInvalid: string | undefined;
		if (2 + minNameCols + 1 + visibleWidth(fullBadgePlain) > cw) {
			if (2 + minNameCols + 1 + visibleWidth(statusPlain) <= cw) {
				prefix = "";
			} else if (safeInvalid !== undefined) {
				prefix = "";
				badgeStatusPlain = "✗";
				wrappedInvalid = safeInvalid;
			}
		}
		const badgePlain = `${prefix}${badgeStatusPlain}`;
		const marker = active ? this.theme.fg("accent", "▸") : " ";
		const nameBudget = Math.max(1, cw - visibleWidth(badgePlain) - 3);
		const nameShown = truncateToWidth(safeName, nameBudget, "…");
		const nameStyled = active
			? this.theme.fg("accent", this.theme.bold(nameShown))
			: this.theme.fg("text", nameShown);
		const status =
			safeInvalid === undefined
				? this.theme.fg("success", badgeStatusPlain)
				: this.theme.fg(this.invalid.has(index) || !field.required ? "error" : "warning", badgeStatusPlain);
		const badge = `${prefix ? this.theme.fg("dim", prefix) : ""}${status}`;
		const gap = Math.max(1, cw - 2 - visibleWidth(nameShown) - visibleWidth(badgePlain));
		return {
			line: `${marker} ${nameStyled}${" ".repeat(gap)}${badge}`,
			wrappedInvalid,
		};
	}

	private submitRow(): string {
		const label = sanitizeSingleLine(this.submitLabel);
		const active = this.focusedIndex === this.fields.length;
		const marker = active ? this.theme.fg("accent", "▸") : " ";
		const pill = active
			? this.theme.bg("selectedBg", this.theme.bold(this.theme.fg("accent", label)))
			: this.theme.fg("dim", label);
		return `${marker} ${pill}`;
	}

	private footerRow(): string {
		const dim = (t: string): string => this.theme.fg("dim", t);
		const hint = (keyText: string, key: KeyId, label: string): string =>
			clickableKeysHint([{ text: this.theme.fg("accent", keyText), key }], ` ${dim(label)}`);
		const sep = dim(" · ");
		const focused = this.fields[this.focusedIndex];
		const enter = focused === undefined ? "submit" : focused.type === "text" ? "new line" : "next";
		return `${hint("enter", "enter", enter)}${sep}${hint("tab", "tab", "between fields")}${sep}${hint("esc", "escape", "cancel")}`;
	}

	private frame(body: readonly string[], inner: number, cw: number, boxWidth: number): string[] {
		const border = (glyph: string): string => this.theme.fg("border", glyph);
		const safeHeading = sanitizeSingleLine(this.heading);
		const headingClipped =
			safeHeading.length > 0 && inner >= 2 ? truncateToWidth(safeHeading, Math.max(0, inner - 2), "…") : "";
		const title = headingClipped.length > 0 ? ` ${this.theme.fg("accent", this.theme.bold(headingClipped))} ` : "";
		const top = truncateToWidth(
			`${border("╭")}${title}${border("─".repeat(Math.max(0, inner - visibleWidth(title))))}${border("╮")}`,
			boxWidth,
			"",
		);
		const rows = body.map((line) => {
			if (boxWidth < 4) {
				const clippedNarrow = truncateToWidth(line, inner, "");
				const padNarrow = " ".repeat(Math.max(0, inner - visibleWidth(clippedNarrow)));
				return truncateToWidth(`${border("│")}${clippedNarrow}${padNarrow}${border("│")}`, boxWidth, "");
			}
			const clipped = visibleWidth(line) > cw ? truncateToWidth(line, cw, "…") : line;
			const pad = " ".repeat(Math.max(0, cw - visibleWidth(clipped)));
			return `${border("│")} ${clipped}${pad} ${border("│")}`;
		});
		const bottom = truncateToWidth(`${border("╰")}${border("─".repeat(inner))}${border("╯")}`, boxWidth, "");
		return [top, ...rows, bottom];
	}
}
