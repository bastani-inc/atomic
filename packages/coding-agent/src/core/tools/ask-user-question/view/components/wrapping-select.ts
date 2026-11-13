import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { OVERLAY_ACTIVE_ROW_MARKER } from "../../../../extensions/ui-types.js";
import { ROW_INTENT_META } from "../../state/row-intent.ts";
import { type FieldTone, fieldTone, rowTone } from "../../state/selectors/field-tone.ts";

/**
 * Row-intent discriminated union. `kind` is the single discriminator —
 * pre-1.0.3 boolean flags have been removed (see `banned-flags.test.ts`).
 * Modeled after `QuestionnaireAction` (`key-router.ts:13-32`) and `Effect`
 * (`state-reducer.ts:26-32`) — pure literal-tagged variants, no shared base,
 * exhaustive-`switch` enforcement via non-`void` returns.
 *
 * Variant semantics:
 * - `option`: a regular author-defined option row.
 * - `other`: the inline free-text input row appended to single-select questions
 *   (label is "Type something."). Renders as inline `Input` when active.
 * - `chat`: the abandon-questionnaire escape-hatch row (label is "Chat about this").
 *   Renders as inline `Input` when active.
 * - `next`: the explicit commit-and-advance row appended to multi-select questions
 *   (label is "Next"). Renders without a number / checkbox.
 */
export type WrappingSelectItem =
	| { kind: "option"; label: string; description?: string }
	| { kind: "other"; label: string; description?: string }
	| { kind: "chat"; label: string; description?: string }
	| { kind: "next"; label: string; description?: string };

export interface WrappingSelectTheme {
	/** Paints a row or inline field in its tone; tones come from `field-tone.ts`. */
	field: (tone: FieldTone, text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
}

/**
 * Numbering controls.
 *
 * Use `numberStartOffset` + `totalItemsForNumbering` when a list is logically a slice of a
 * larger numbered sequence — e.g. the chat row lives in its own WrappingSelect but should
 * render as `(N+1).` where N is the previous list's item count, with the column padded as
 * if both lists were one continuous numbered sequence.
 */
export interface WrappingSelectOptions {
	/** Start numbering at this offset + 1 (default 0 → rows labeled 1, 2, 3 …). */
	numberStartOffset?: number;
	/** Override the total used to pad the number column (useful when items span multiple lists). */
	totalItemsForNumbering?: number;
	/** When false, rows that normally open an inline editor stay ordinary labeled rows. */
	inlineInputEnabled?: boolean;
}

export class WrappingSelect implements Component {
	private static readonly ACTIVE_POINTER = "❯ ";
	private static readonly INACTIVE_POINTER = "  ";
	private static readonly NUMBER_SEPARATOR = ". ";
	private static readonly CURSOR_INVERSE_START = "\x1b[7m";
	// Reverse-video off only: a full reset would drop the field color after the caret (#4741).
	private static readonly CURSOR_INVERSE_END = "\x1b[27m";
	private static readonly CONFIRMED_MARK = " ✔";
	private static readonly MIN_CONTENT_WIDTH = 1;

	private readonly items: readonly WrappingSelectItem[];
	private readonly maxVisible: number;
	private readonly theme: WrappingSelectTheme;
	private readonly inlineInputEnabled: boolean;
	private numberStartOffset: number;
	private totalItemsForNumbering: number;

	private selectedIndex = 0;
	private focused = true;
	private inputBuffer = "";
	private inputCursor: number | undefined = undefined;
	/**
	 * Index of the row that was previously confirmed for this list (e.g. the user's prior
	 * answer when re-entering a multi-question tab). Renders `<label> ✔` in the `answered`
	 * tone WITHOUT the `❯` pointer — pointer is reserved for the live cursor. When
	 * `selectedIndex === confirmedIndex && focused`, the row takes the `editing` tone.
	 */
	private confirmedIndex: number | undefined = undefined;
	/**
	 * When set together with `confirmedIndex`, replaces the row's static label at render time.
	 * Used for the `kind: "other"` sentinel — its label is "Type something." but if the user's
	 * prior answer was custom text, we render that text instead (e.g. `4. Hello ✔`).
	 */
	private confirmedLabelOverride: string | undefined = undefined;

	constructor(
		items: readonly WrappingSelectItem[],
		maxVisible: number,
		theme: WrappingSelectTheme,
		options: WrappingSelectOptions = {},
	) {
		this.items = items;
		this.maxVisible = Math.max(1, maxVisible);
		this.theme = theme;
		this.inlineInputEnabled = options.inlineInputEnabled !== false;
		this.numberStartOffset = options.numberStartOffset ?? 0;
		this.totalItemsForNumbering = options.totalItemsForNumbering ?? items.length;
	}

	/**
	 * Update the numbering offset + total padding width without rebuilding the component.
	 * Used by the host to keep the chat-row WrappingSelect's number aligned with the active tab's
	 * options list when the user switches tabs (each tab can have a different items count).
	 */
	setNumbering(numberStartOffset: number, totalItemsForNumbering: number): void {
		this.numberStartOffset = numberStartOffset;
		this.totalItemsForNumbering = Math.max(1, totalItemsForNumbering);
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, this.items.length - 1));
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
	}

	/**
	 * Mark a previously-confirmed row. Pass `undefined` to clear. `labelOverride` replaces
	 * the row's static `item.label` at render time — used for the `kind: "other"` sentinel so
	 * the row reads `Hello ✔` instead of `Type something. ✔` when the prior answer was custom
	 * text.
	 */
	setConfirmedIndex(index: number | undefined, labelOverride?: string): void {
		if (index === undefined) {
			this.confirmedIndex = undefined;
			this.confirmedLabelOverride = undefined;
			return;
		}
		this.confirmedIndex = Math.max(0, Math.min(index, this.items.length - 1));
		this.confirmedLabelOverride = labelOverride;
	}

	setInputBuffer(text: string): void {
		this.inputBuffer = text;
		if (this.inputCursor !== undefined) this.inputCursor = this.clampInputCursor(this.inputCursor);
	}

	setInputCursor(cursor: number): void {
		this.inputCursor = this.clampInputCursor(cursor);
	}

	/** Intentionally empty — input is routed at the container level. */
	handleInput(_data: string): void {}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.items.length === 0) return [];

		const { startIndex, endIndex } = this.computeVisibleWindow();
		const numberWidth = String(Math.max(1, this.totalItemsForNumbering)).length;
		const lines: string[] = [];

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.items[i];
			if (!item) continue;
			const isActive = i === this.selectedIndex && this.focused;
			const itemLines = this.renderItem(item, i, isActive, width, numberWidth);
			// Tell a bounding host which row it must not crop away (#2378). The mark
			// is zero-width and the host strips it; see OVERLAY_ACTIVE_ROW_MARKER.
			if (isActive && itemLines.length > 0) {
				itemLines[0] = `${itemLines[0] ?? ""}${OVERLAY_ACTIVE_ROW_MARKER}`;
			}
			lines.push(...itemLines);
		}

		if (this.hasItemsOutsideWindow(startIndex, endIndex)) {
			lines.push(this.theme.scrollInfo(`  (${this.selectedIndex + 1}/${this.items.length})`));
		}
		return lines;
	}

	private computeVisibleWindow(): { startIndex: number; endIndex: number } {
		const half = Math.floor(this.maxVisible / 2);
		const startIndex = Math.max(0, Math.min(this.selectedIndex - half, this.items.length - this.maxVisible));
		const endIndex = Math.min(startIndex + this.maxVisible, this.items.length);
		return { startIndex, endIndex };
	}

	private hasItemsOutsideWindow(startIndex: number, endIndex: number): boolean {
		return startIndex > 0 || endIndex < this.items.length;
	}

	private renderItem(
		item: WrappingSelectItem,
		index: number,
		isActive: boolean,
		width: number,
		numberWidth: number,
	): string[] {
		const rowPrefix = this.buildRowPrefix(index, isActive, numberWidth);
		const continuationPrefix = " ".repeat(visibleWidth(rowPrefix));
		const contentWidth = Math.max(WrappingSelect.MIN_CONTENT_WIDTH, width - visibleWidth(rowPrefix));

		if (this.isInlineField(item)) {
			if (isActive) return this.renderInlineInputRow(rowPrefix, continuationPrefix, contentWidth);
			return [
				...this.renderInlineFieldAtRest(item, index, rowPrefix, contentWidth),
				...this.renderDescriptionBlock(item.description, continuationPrefix, contentWidth),
			];
		}

		// Confirmed row gets a trailing ` ✔`; pointer is independent (still ❯ when active).
		// When `index === confirmedIndex` AND `isActive`, both `❯` and `✔` appear on the same
		// row — load-bearing for the case where the prior answer was row 0 (cursor resets to
		// 0 on tab-back, so the confirmed row IS the active row).
		const isConfirmed = index === this.confirmedIndex;
		const label = isConfirmed ? `${item.label}${WrappingSelect.CONFIRMED_MARK}` : item.label;

		return [
			...this.renderLabelBlock(label, rowPrefix, continuationPrefix, contentWidth, rowTone(isActive, isConfirmed)),
			...this.renderDescriptionBlock(item.description, continuationPrefix, contentWidth),
		];
	}

	/**
	 * An inline field without focus shows what it holds: the in-flight draft, else the
	 * confirmed answer (`confirmedLabelOverride`), else its own label as the placeholder.
	 * The ` ✔` mark only follows text that is the confirmed answer. The row stays one line,
	 * truncated, so a long draft does not change the dialog's height once focus leaves it;
	 * the editor shows the full text again on focus.
	 */
	private renderInlineFieldAtRest(
		item: WrappingSelectItem,
		index: number,
		rowPrefix: string,
		contentWidth: number,
	): string[] {
		const confirmedValue = index === this.confirmedIndex ? (this.confirmedLabelOverride ?? "") : "";
		const value = this.inputBuffer.trim().length > 0 ? this.inputBuffer : confirmedValue;
		const tone = fieldTone(false, value);
		const text = tone === "placeholder" ? item.label : value;
		const mark = confirmedValue.length > 0 && value === confirmedValue ? WrappingSelect.CONFIRMED_MARK : "";
		const fitted = truncateToWidth(text, Math.max(1, contentWidth - visibleWidth(mark)), "…");
		return [this.theme.field(tone, `${rowPrefix}${fitted}${mark}`)];
	}

	private buildRowPrefix(index: number, isActive: boolean, numberWidth: number): string {
		const pointer = isActive ? WrappingSelect.ACTIVE_POINTER : WrappingSelect.INACTIVE_POINTER;
		const displayNumber = this.numberStartOffset + index + 1;
		const paddedNumber = String(displayNumber).padStart(numberWidth, " ");
		return `${pointer}${paddedNumber}${WrappingSelect.NUMBER_SEPARATOR}`;
	}

	private isInlineField(item: WrappingSelectItem): boolean {
		return this.inlineInputEnabled && ROW_INTENT_META[item.kind].activatesInputMode;
	}

	/**
	 * Render the inline input row across one or more lines, wrapping at `contentWidth`
	 * so long input doesn't run off the right edge or trip the parent renderer's
	 * width invariant. Mirrors `renderLabelBlock`'s contract: first line carries
	 * `rowPrefix`, continuation lines carry `continuationPrefix` (spaces), and every
	 * emitted line is painted in the `editing` tone. The cursor mirrors the
	 * main chat editor: inverse-video over the character at the caret, or an
	 * inverse-video space at end-of-line.
	 */
	private renderInlineInputRow(rowPrefix: string, continuationPrefix: string, contentWidth: number): string[] {
		const raw = this.inputTextWithCursor();
		const wrapped = wrapTextWithAnsi(raw, contentWidth);
		return wrapped.map((segment, index) => {
			const prefix = index === 0 ? rowPrefix : continuationPrefix;
			return this.theme.field("editing", `${prefix}${segment}`);
		});
	}

	private inputTextWithCursor(): string {
		const cursor = this.clampInputCursor(this.inputCursor ?? this.inputBuffer.length);
		const before = this.inputBuffer.slice(0, cursor);
		const after = this.inputBuffer.slice(cursor);
		const [at = ""] = Array.from(after);
		if (at === "") {
			return `${before}${WrappingSelect.CURSOR_INVERSE_START} ${WrappingSelect.CURSOR_INVERSE_END}`;
		}
		const rest = after.slice(at.length);
		return `${before}${WrappingSelect.CURSOR_INVERSE_START}${at}${WrappingSelect.CURSOR_INVERSE_END}${rest}`;
	}

	private clampInputCursor(cursor: number): number {
		if (!Number.isFinite(cursor)) return this.inputBuffer.length;
		return Math.max(0, Math.min(cursor, this.inputBuffer.length));
	}

	private renderLabelBlock(
		label: string,
		rowPrefix: string,
		continuationPrefix: string,
		contentWidth: number,
		tone: FieldTone | undefined,
	): string[] {
		const wrapped = wrapTextWithAnsi(label, contentWidth);
		return wrapped.map((segment, index) => {
			const prefix = index === 0 ? rowPrefix : continuationPrefix;
			const line = `${prefix}${segment}`;
			return tone ? this.theme.field(tone, line) : line;
		});
	}

	private renderDescriptionBlock(
		description: string | undefined,
		continuationPrefix: string,
		contentWidth: number,
	): string[] {
		if (!description) return [];
		const wrapped = wrapTextWithAnsi(description, contentWidth);
		return wrapped.map((segment) => `${continuationPrefix}${this.theme.description(segment)}`);
	}
}
