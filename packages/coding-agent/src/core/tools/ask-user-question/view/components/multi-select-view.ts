import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "../../../../../modes/interactive/theme/theme.ts";
import { ROW_INTENT_META } from "../../state/row-intent.ts";
import type { QuestionData } from "../../tool/types.ts";
import type { StatefulView } from "../stateful-view.ts";

const ACTIVE_POINTER = "❯ ";
const INACTIVE_POINTER = "  ";
const CHECKED = "[✔]";
const UNCHECKED = "[ ]";
const NUMBER_SEPARATOR = ". ";
const BOX_LABEL_GAP = " ";
// CC parity: description continuation indents to col 2 (past the pointer slot), NOT to the
// full prefix column. Wrap width still uses prefixVisibleWidth so naturalHeight matches render.
const CONTINUATION_INDENT = "  ";

export const MULTI_SUBMIT_LABEL = "Submit";

export interface MultiSelectViewProps {
	rows: ReadonlyArray<{ checked: boolean; active: boolean }>;
	nextActive: boolean;
	nextLabel: string;
}

/**
 * Renders the multi-select option list (one row per option — pointer + checkbox + label —
 * plus zero or more wrapped continuation lines per description).
 *
 * `naturalHeight(width)` is state-INDEPENDENT (depends only on theme glyph widths,
 * question.options, and width) so the host can compute a stable globalContentHeight
 * without rendering. `naturalHeight(w) === render(w).length` for every props.
 *
 * `setProps(props)` is a pure field reassignment — no render, no invalidate side effects.
 */
export class MultiSelectView implements StatefulView<MultiSelectViewProps> {
	private props: MultiSelectViewProps;

	private declare readonly theme: Theme;
	private declare readonly question: QuestionData;

	constructor(theme: Theme, question: QuestionData) {
		this.theme = theme;
		this.question = question;
		this.props = { rows: [], nextActive: false, nextLabel: ROW_INTENT_META.next.label };
	}

	setProps(props: MultiSelectViewProps): void {
		this.props = props;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const prefixWidth = this.prefixVisibleWidth();
		const contentWidth = Math.max(1, width - prefixWidth);
		const numberWidth = String(Math.max(1, this.question.options.length)).length;
		for (let i = 0; i < this.question.options.length; i++) {
			const opt = this.question.options[i];
			const row = this.props.rows[i];
			if (!opt || !row) continue;
			const pointer = row.active ? this.theme.fg("accent", ACTIVE_POINTER) : INACTIVE_POINTER;
			// Checked uses the same `accent` hue as the active-row label so checked rows read
			// as "selected" rather than "success" — matches the visual rhythm of the rest of
			// the dialog (active pointer, label, picker rows are all accent).
			const box = row.checked ? this.theme.fg("accent", CHECKED) : this.theme.fg("muted", UNCHECKED);
			const label = truncateToWidth(opt.label, contentWidth, "…");
			const styledLabel = row.active ? this.theme.fg("accent", this.theme.bold(label)) : label;
			const num = String(i + 1).padStart(numberWidth, " ");
			const line = `${pointer}${num}${NUMBER_SEPARATOR}${box}${BOX_LABEL_GAP}${styledLabel}`;
			lines.push(truncateToWidth(line, width, ""));
			if (opt.description) {
				const wrapped = wrapTextWithAnsi(opt.description, contentWidth);
				for (const segment of wrapped) {
					lines.push(CONTINUATION_INDENT + this.theme.fg("muted", segment));
				}
			}
		}
		const nextPointer = this.props.nextActive ? this.theme.fg("accent", ACTIVE_POINTER) : INACTIVE_POINTER;
		const nextLabel = this.props.nextActive
			? this.theme.fg("accent", this.theme.bold(this.props.nextLabel))
			: this.props.nextLabel;
		lines.push(truncateToWidth(`${nextPointer}${nextLabel}`, width, ""));
		return lines;
	}

	naturalHeight(width: number): number {
		const contentWidth = Math.max(1, width - this.prefixVisibleWidth());
		let total = 0;
		for (const opt of this.question.options) {
			if (!opt) continue;
			total += 1; // row line
			if (opt.description) {
				total += wrapTextWithAnsi(opt.description, contentWidth).length;
			}
		}
		return total + 1; // Next sentinel row (no description; never wraps).
	}

	private prefixVisibleWidth(): number {
		// Canonical prefix for OPTION rows: INACTIVE_POINTER + numberWidth digits + NUMBER_SEPARATOR
		// + UNCHECKED + BOX_LABEL_GAP. State-independent because ACTIVE/INACTIVE pointer share
		// visibleWidth, CHECKED/UNCHECKED share visibleWidth, and numberWidth is constant per question.
		// The Next sentinel uses a bare `pointer + "Next"` shape — its width never exceeds this prefix
		// at any reasonable terminal width, so it's safe to leave it out of the canonical computation.
		const numberWidth = String(Math.max(1, this.question.options.length)).length;
		return (
			visibleWidth(INACTIVE_POINTER) + numberWidth + visibleWidth(`${NUMBER_SEPARATOR}${UNCHECKED}${BOX_LABEL_GAP}`)
		);
	}
}
