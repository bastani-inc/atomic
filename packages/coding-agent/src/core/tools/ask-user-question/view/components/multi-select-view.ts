import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@bastani/atomic-tui";
import type { Theme } from "../../../../../modes/interactive/theme/theme.js";
import { singleLineDisplayText, terminalDisplayText } from "../../../../../utils/terminal-text.ts";
import { OVERLAY_ACTIVE_ROW_MARKER } from "../../../../extensions/ui-types.js";
import { ROW_INTENT_META } from "../../state/row-intent.ts";
import { rowTone, styleFieldTone } from "../../state/selectors/field-tone.ts";
import type { QuestionData } from "../../tool/types.js";
import type { StatefulView } from "../stateful-view.ts";

const ACTIVE_POINTER = "∀ ";
const INACTIVE_POINTER = "  ";
const CHECKED = "[✔]";
const UNCHECKED = "[ ]";
const NUMBER_SEPARATOR = ". ";
const BOX_LABEL_GAP = " ";

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
 * without rendering. `naturalHeight(w) === render(w).length` for every props. It is
 * measured once per width.
 *
 * `setProps(props)` is a pure field reassignment — no render, no invalidate side effects.
 */
export class MultiSelectView implements StatefulView<MultiSelectViewProps> {
	private props: MultiSelectViewProps;
	private measured: { readonly width: number; readonly height: number } | undefined;

	private declare readonly theme: Theme;
	private declare readonly question: QuestionData;

	constructor(theme: Theme, question: QuestionData) {
		this.theme = theme;
		this.question = {
			...question,
			options: question.options.map((option) => ({
				...option,
				label: singleLineDisplayText(option.label),
				description: terminalDisplayText(option.description),
			})),
		};
		this.props = { rows: [], nextActive: false, nextLabel: ROW_INTENT_META.next.label };
	}

	setProps(props: MultiSelectViewProps): void {
		this.props = props;
	}

	handleInput(_data: string): void {}

	invalidate(): void {
		this.measured = undefined;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const prefixWidth = this.prefixVisibleWidth();
		const contentWidth = Math.max(1, width - prefixWidth);
		const numberWidth = String(this.question.options.length + 1).length;
		const descriptionIndent = " ".repeat(prefixWidth);
		for (let i = 0; i < this.question.options.length; i++) {
			const opt = this.question.options[i];
			const row = this.props.rows[i];
			if (!opt || !row) continue;
			const pointer = row.active ? this.theme.fg("accent", ACTIVE_POINTER) : INACTIVE_POINTER;
			// A checked row holds part of the answer: `editing` while focused, `answered` otherwise.
			const tone = rowTone(row.active, row.checked);
			const box =
				row.checked && tone ? styleFieldTone(this.theme, tone, CHECKED) : this.theme.fg("muted", UNCHECKED);
			const label = truncateToWidth(opt.label, contentWidth, "…");
			const styledLabel = tone ? styleFieldTone(this.theme, tone, label) : label;
			const num = String(i + 1).padStart(numberWidth, " ");
			const line = `${pointer}${num}${NUMBER_SEPARATOR}${box}${BOX_LABEL_GAP}${styledLabel}`;
			const rendered = truncateToWidth(line, width, "");
			lines.push(`${rendered}${row.active ? OVERLAY_ACTIVE_ROW_MARKER : ""}`);
			if (opt.description) {
				const wrapped = wrapTextWithAnsi(opt.description, contentWidth);
				for (const segment of wrapped) {
					lines.push(descriptionIndent + this.theme.fg("muted", segment));
				}
			}
		}
		const nextPointer = this.props.nextActive ? this.theme.fg("accent", ACTIVE_POINTER) : INACTIVE_POINTER;
		const nextLabel = this.props.nextActive
			? styleFieldTone(this.theme, "editing", this.props.nextLabel)
			: this.props.nextLabel;
		const nextNumber = String(this.question.options.length + 1).padStart(numberWidth, " ");
		const rendered = truncateToWidth(`${nextPointer}${nextNumber}${NUMBER_SEPARATOR}${nextLabel}`, width, "");
		lines.push(`${rendered}${this.props.nextActive ? OVERLAY_ACTIVE_ROW_MARKER : ""}`);
		return lines;
	}

	naturalHeight(width: number): number {
		if (this.measured?.width !== width) this.measured = { width, height: this.measureHeight(width) };
		return this.measured.height;
	}

	private measureHeight(width: number): number {
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
		const numberWidth = String(this.question.options.length + 1).length;
		return (
			visibleWidth(INACTIVE_POINTER) + numberWidth + visibleWidth(`${NUMBER_SEPARATOR}${UNCHECKED}${BOX_LABEL_GAP}`)
		);
	}
}
