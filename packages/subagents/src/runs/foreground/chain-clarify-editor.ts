import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";

export interface TextEditorState {
	buffer: string;
	cursor: number;
	viewportOffset: number;
}

export function createEditorState(initial = ""): TextEditorState {
	return { buffer: initial, cursor: 0, viewportOffset: 0 };
}

export function wrapText(text: string, width: number): { lines: string[]; starts: number[] } {
	if (width <= 0) return { lines: [text], starts: [0] };
	if (text.length === 0) return { lines: [""], starts: [0] };

	const lines: string[] = [];
	const starts: number[] = [];
	let offset = 0;
	const segments = text.split("\n");
	for (const [index, segment] of segments.entries()) {
		if (segment.length === 0) {
			starts.push(offset);
			lines.push("");
		} else {
			let lineStart = 0;
			let pos = 0;
			let lineWidth = 0;
			while (pos < segment.length) {
				const char = String.fromCodePoint(segment.codePointAt(pos)!);
				const charWidth = visibleWidth(char);
				if (lineWidth > 0 && lineWidth + charWidth > width) {
					starts.push(offset + lineStart);
					lines.push(segment.slice(lineStart, pos));
					lineStart = pos;
					lineWidth = 0;
					continue;
				}
				pos += char.length;
				lineWidth += charWidth;
			}
			starts.push(offset + lineStart);
			lines.push(segment.slice(lineStart));
		}
		offset += segment.length + (index < segments.length - 1 ? 1 : 0);
	}
	if (!text.endsWith("\n") && text.length > 0 && visibleWidth(lines[lines.length - 1] ?? "") === width) {
		starts.push(text.length);
		lines.push("");
	}
	return { lines, starts };
}

export function getCursorDisplayPos(cursor: number, starts: number[]): { line: number; col: number } {
	for (let i = starts.length - 1; i >= 0; i--) {
		if (cursor >= starts[i]!) return { line: i, col: cursor - starts[i]! };
	}
	return { line: 0, col: 0 };
}

export function ensureCursorVisible(cursorLine: number, viewportHeight: number, currentOffset: number): number {
	if (cursorLine < currentOffset) return Math.max(0, cursorLine);
	if (cursorLine >= currentOffset + viewportHeight) return Math.max(0, cursorLine - viewportHeight + 1);
	return Math.max(0, currentOffset);
}

function isWordChar(ch: string): boolean {
	const code = ch.charCodeAt(0);
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function wordBackward(buffer: string, cursor: number): number {
	let pos = cursor;
	while (pos > 0 && !isWordChar(buffer[pos - 1]!)) pos--;
	while (pos > 0 && isWordChar(buffer[pos - 1]!)) pos--;
	return pos;
}

function wordForward(buffer: string, cursor: number): number {
	let pos = cursor;
	while (pos < buffer.length && isWordChar(buffer[pos]!)) pos++;
	while (pos < buffer.length && !isWordChar(buffer[pos]!)) pos++;
	return pos;
}

function normalizeInsertText(data: string): string | null {
	let text = data.split("\x1b[200~").join("").split("\x1b[201~").join("");
	text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const newline = text.indexOf("\n");
	if (newline !== -1) text = text.slice(0, newline);
	text = text.replace(/\t/g, "    ");
	if (text.length === 0) return null;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) < 32) return null;
	}
	return text;
}

export function handleEditorInput(state: TextEditorState, data: string, textWidth: number): TextEditorState | null {
	if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "return")) return null;

	const { lines: wrapped, starts } = wrapText(state.buffer, textWidth);
	const cursorPos = getCursorDisplayPos(state.cursor, starts);

	if (matchesKey(data, "alt+left") || matchesKey(data, "ctrl+left")) return { ...state, cursor: wordBackward(state.buffer, state.cursor) };
	if (matchesKey(data, "alt+right") || matchesKey(data, "ctrl+right")) return { ...state, cursor: wordForward(state.buffer, state.cursor) };
	if (matchesKey(data, "left")) return state.cursor > 0 ? { ...state, cursor: state.cursor - 1 } : state;
	if (matchesKey(data, "right")) return state.cursor < state.buffer.length ? { ...state, cursor: state.cursor + 1 } : state;
	if (matchesKey(data, "up") && cursorPos.line > 0) {
		const targetLine = cursorPos.line - 1;
		return { ...state, cursor: starts[targetLine]! + Math.min(cursorPos.col, wrapped[targetLine]?.length ?? 0) };
	}
	if (matchesKey(data, "down") && cursorPos.line < wrapped.length - 1) {
		const targetLine = cursorPos.line + 1;
		return { ...state, cursor: starts[targetLine]! + Math.min(cursorPos.col, wrapped[targetLine]?.length ?? 0) };
	}
	if (matchesKey(data, "home")) return { ...state, cursor: starts[cursorPos.line]! };
	if (matchesKey(data, "end")) return { ...state, cursor: starts[cursorPos.line]! + (wrapped[cursorPos.line]?.length ?? 0) };
	if (matchesKey(data, "ctrl+home")) return { ...state, cursor: 0 };
	if (matchesKey(data, "ctrl+end")) return { ...state, cursor: state.buffer.length };
	if (matchesKey(data, "alt+backspace")) {
		const target = wordBackward(state.buffer, state.cursor);
		return target === state.cursor ? state : { ...state, buffer: state.buffer.slice(0, target) + state.buffer.slice(state.cursor), cursor: target };
	}
	if (matchesKey(data, "backspace")) {
		return state.cursor > 0
			? { ...state, buffer: state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor), cursor: state.cursor - 1 }
			: state;
	}
	if (matchesKey(data, "delete")) {
		return state.cursor < state.buffer.length
			? { ...state, buffer: state.buffer.slice(0, state.cursor) + state.buffer.slice(state.cursor + 1) }
			: state;
	}

	const insert = normalizeInsertText(data);
	return insert
		? { ...state, buffer: state.buffer.slice(0, state.cursor) + insert + state.buffer.slice(state.cursor), cursor: state.cursor + insert.length }
		: null;
}

function renderWithCursor(text: string, cursorPos: number): string {
	const before = text.slice(0, cursorPos);
	const cursorChar = text[cursorPos] ?? " ";
	const after = text.slice(cursorPos + 1);
	return `${before}\x1b[7m${cursorChar}\x1b[27m${after}`;
}

export function renderEditor(state: TextEditorState, width: number, viewportHeight: number): string[] {
	const { lines: wrapped, starts } = wrapText(state.buffer, width);
	const cursorPos = getCursorDisplayPos(state.cursor, starts);
	const lines: string[] = [];
	for (let i = 0; i < viewportHeight; i++) {
		const lineIdx = state.viewportOffset + i;
		let content = lineIdx < wrapped.length ? wrapped[lineIdx] ?? "" : "";
		if (lineIdx === cursorPos.line) content = renderWithCursor(content, cursorPos.col);
		lines.push(content);
	}
	return lines;
}
