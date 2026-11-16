import type { ThinkingLevel } from "@bastani/atomic-agent-core";
import { keyDisplayText } from "./keybinding-hints.js";
import { FramedSelector, type SelectorItem } from "./selector.ts";

const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

/** The `/thinking` picker: one row per level the model supports, the current level marked `●`. */
export class ThinkingSelectorComponent extends FramedSelector<ThinkingLevel> {
	constructor(
		currentLevel: ThinkingLevel,
		availableLevels: ThinkingLevel[],
		onSelectLevel: (level: ThinkingLevel) => void,
		onCancelSelect: () => void,
		defaultThinkingLevel?: ThinkingLevel,
	) {
		const cycle = keyDisplayText("app.thinking.cycle");
		super({
			title: "Thinking level",
			subtitle: cycle ? `${cycle} cycles thinking levels` : undefined,
			search: true,
			items: availableLevels.map(
				(level): SelectorItem<ThinkingLevel> => ({
					id: level,
					value: level,
					label: level,
					description: LEVEL_DESCRIPTIONS[level],
					mark: level === currentLevel ? "on" : "off",
					tag: level === defaultThinkingLevel ? "default" : undefined,
				}),
			),
			initialId: currentLevel,
			maxVisible: Math.max(1, availableLevels.length),
			onSelect: (item) => onSelectLevel(item.value),
			onCancel: onCancelSelect,
		});
	}
}
