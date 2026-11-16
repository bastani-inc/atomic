import { FramedSelector } from "./selector.ts";

/** Picks whether images are drawn inline in the terminal or shown as a text placeholder. */
export class ShowImagesSelectorComponent extends FramedSelector<boolean> {
	constructor(currentValue: boolean, onSelect: (show: boolean) => void, onCancel: () => void) {
		super({
			title: "Show images",
			items: [
				{ id: "yes", value: true, label: "Yes", description: "Show images inline in the terminal" },
				{ id: "no", value: false, label: "No", description: "Show a text placeholder instead" },
			].map((item) => ({ ...item, mark: item.value === currentValue ? ("on" as const) : ("off" as const) })),
			initialId: currentValue ? "yes" : "no",
			onSelect: (item) => onSelect(item.value),
			onCancel,
		});
	}
}
