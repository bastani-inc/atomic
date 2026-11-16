import { getAvailableThemes } from "../theme/theme.js";
import { FramedSelector } from "./selector.ts";

/** The theme picker: moving the selection previews the theme; enter keeps it and esc restores the current one. */
export class ThemeSelectorComponent extends FramedSelector<string> {
	constructor(
		currentTheme: string,
		onSelect: (themeName: string) => void,
		onCancel: () => void,
		onPreview: (themeName: string) => void,
	) {
		super({
			title: "Theme",
			search: true,
			items: getAvailableThemes().map((name) => ({
				id: name,
				value: name,
				label: name,
				mark: name === currentTheme ? "on" : "off",
				tag: name === currentTheme ? "current" : undefined,
			})),
			initialId: currentTheme,
			onSelect: (item) => onSelect(item.value),
			onCancel,
			onSelectionChange: (item) => {
				if (item) onPreview(item.value);
			},
		});
	}
}
