import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../../../../../modes/interactive/theme/theme.ts";
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

	render(width: number): string[] {
		const pieces: string[] = [" ← "];

		for (const tab of this.props.tabs) {
			const box = tab.answered ? "■" : "□";
			const rawSeg = ` ${box} ${tab.label} `;
			const styled = tab.active
				? this.theme.bg("selectedBg", this.theme.fg("text", rawSeg))
				: this.theme.fg(tab.answered ? "success" : "muted", rawSeg);
			pieces.push(styled);
			pieces.push(" ");
		}

		const submitText = " ✓ Submit ";
		const submitStyled = this.props.submit.active
			? this.theme.bg("selectedBg", this.theme.fg("text", submitText))
			: this.theme.fg(this.props.submit.allAnswered ? "success" : "dim", submitText);
		pieces.push(submitStyled);
		pieces.push(" →");

		const tabLine = truncateToWidth(pieces.join(""), width, "");
		return [tabLine, ""];
	}
}
