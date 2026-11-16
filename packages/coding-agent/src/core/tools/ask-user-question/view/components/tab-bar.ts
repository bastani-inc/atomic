import { truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import type { Theme } from "../../../../../modes/interactive/theme/theme.js";
import type { StatefulView } from "../stateful-view.ts";

/**
 * Per-tick projection of TabBar state. The selector
 * (`selectTabBarProps`) hoists every render-time derivation
 * (`allAnswered`, `answered`, `isActive`, `submitActive`) into props so
 * `render()` is pure styling. Replaces the prior `setConfig(TabBarConfig)`
 * snowflake and the inline `+ 1` magic at `props-adapter.ts:127`.
 */
export interface TabBarProps {
	/** One per author-defined question, in order. */
	tabs: ReadonlyArray<{ label: string; answered: boolean; active: boolean }>;
	/** Submit-tab state. `allAnswered` drives the success/dim color picker. */
	submit: { active: boolean; allAnswered: boolean };
}

export class TabBar implements StatefulView<TabBarProps> {
	private props: TabBarProps;

	private declare readonly theme: Theme;

	constructor(theme: Theme) {
		this.theme = theme;
		this.props = { tabs: [], submit: { active: false, allAnswered: false } };
	}

	setProps(props: TabBarProps): void {
		this.props = props;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	/**
	 * The steps of the dialog on one line: each question's header, then Review, joined by `──`, the current step as a
	 * filled chip and answered steps in the success colour; the current question's `n/m` (on Review, how many are answered) sits at the right edge.
	 */
	render(width: number): string[] {
		const { theme } = this;
		const step = (label: string, active: boolean, done: boolean): string =>
			active ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg(done ? "success" : "muted", label);
		const steps = [
			...this.props.tabs.map((tab) => step(tab.label, tab.active, tab.answered)),
			step("Review", this.props.submit.active, this.props.submit.allAnswered),
		].join(theme.fg("dim", " ── "));
		const activeIndex = this.props.tabs.findIndex((tab) => tab.active);
		const total = this.props.tabs.length;
		const answered = this.props.tabs.filter((tab) => tab.answered).length;
		const count = activeIndex >= 0 ? `${activeIndex + 1}/${total}` : `${answered}/${total} answered`;
		const room = width - visibleWidth(count) - 2;
		const left = truncateToWidth(steps, Math.max(1, room), "…");
		const gap = Math.max(2, width - visibleWidth(left) - visibleWidth(count));
		return [truncateToWidth(left + " ".repeat(gap) + theme.fg("muted", count), width, "")];
	}
}
