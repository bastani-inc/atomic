import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../../../../../modes/interactive/theme/theme.ts";
import type { StatefulView } from "../stateful-view.ts";

const ACTIVE_POINTER = "❯ ";
const INACTIVE_POINTER = "  ";
const NUMBER_SEPARATOR = ". ";

export const SUBMIT_LABEL = "Submit answers";
export const CANCEL_LABEL = "Cancel";

/**
 * Per-tick projection of SubmitPicker state. The picker is a fixed 2-row
 * structure (Submit / Cancel) — labels are static, only the active marker
 * varies per tick. `selectSubmitPickerProps` precomputes `active` per row.
 */
export interface SubmitPickerProps {
	/** Per-row active flag. Length always 2: row 0 = Submit, row 1 = Cancel. */
	rows: ReadonlyArray<{ active: boolean }>;
}

/**
 * Static 2-row picker rendered on the Submit Tab. Row 0 = "Submit answers", Row 1 = "Cancel".
 *
 * - Active pointer (❯) follows `props.rows[i].active` per tick.
 * - Both rows render in normal style at all times — D1 (revised) allows partial submission,
 *   so Submit is never dimmed or visually marked as unselectable. The warning header in
 *   `buildSubmitContainer` is the sole signal of incompleteness.
 * - `naturalHeight(width)` is state-INDEPENDENT and returns a constant 2, so the
 *   chrome-mirror layout in `buildSubmitContainer` can subtract a fixed 2 lines without
 *   re-rendering.
 */
export class SubmitPicker implements StatefulView<SubmitPickerProps> {
	private props: SubmitPickerProps;

	private declare readonly theme: Theme;

	constructor(theme: Theme) {
		this.theme = theme;
		this.props = { rows: [{ active: false }, { active: false }] };
	}

	setProps(props: SubmitPickerProps): void {
		this.props = props;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	naturalHeight(_width: number): number {
		return 2;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (let i = 0; i < 2; i++) {
			const text = i === 0 ? SUBMIT_LABEL : CANCEL_LABEL;
			const active = this.props.rows[i]?.active ?? false;
			const pointer = active ? ACTIVE_POINTER : INACTIVE_POINTER;
			const number = `${i + 1}${NUMBER_SEPARATOR}`;
			const label = active ? this.theme.fg("accent", this.theme.bold(text)) : this.theme.fg("text", text);
			lines.push(truncateToWidth(`${pointer}${number}${label}`, width, ""));
		}
		return lines;
	}
}
