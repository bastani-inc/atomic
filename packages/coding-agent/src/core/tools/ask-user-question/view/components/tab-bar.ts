import { truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import type { Theme } from "../../../../../modes/interactive/theme/theme.js";
import { singleLineDisplayText } from "../../../../../utils/terminal-text.ts";
import type { StatefulView } from "../stateful-view.ts";

export interface TabBarProps {
	/** One per author-defined question, in order. */
	tabs: ReadonlyArray<{ label: string; answered: boolean; active: boolean }>;
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

	render(width: number): string[] {
		const { theme } = this;
		const step = (label: string, active: boolean, done: boolean): string =>
			active ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg(done ? "success" : "muted", label);
		const steps = [
			...this.props.tabs.map((tab) => step(singleLineDisplayText(tab.label), tab.active, tab.answered)),
			step("Review", this.props.submit.active, this.props.submit.allAnswered),
		].join(theme.fg("dim", " ── "));
		const activeIndex = this.props.tabs.findIndex((tab) => tab.active);
		const total = this.props.tabs.length;
		const answered = this.props.tabs.filter((tab) => tab.answered).length;
		const count = activeIndex >= 0 ? `${activeIndex + 1}/${total}` : `${answered}/${total} answered`;
		const room = width - visibleWidth(count) - 2;
		const left = visibleWidth(steps) > Math.max(1, room) ? truncateToWidth(steps, Math.max(1, room), "…") : steps;
		const gap = Math.max(2, width - visibleWidth(left) - visibleWidth(count));
		const line = left + " ".repeat(gap) + theme.fg("muted", count);
		return [visibleWidth(line) > width ? truncateToWidth(line, width, "") : line];
	}
}
