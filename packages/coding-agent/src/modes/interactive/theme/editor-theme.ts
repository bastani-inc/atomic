import {
	type EditorAutocompleteHintEntry,
	type EditorTheme,
	getKeybindings,
	type SelectListTheme,
} from "@bastani/atomic-tui";
import { type NavKeybindings, type NavKeyStyle, renderAutocompleteHintLine } from "../components/nav-keys.ts";
import { theme } from "./global-theme.ts";

export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

function themeNavKeyStyle(): NavKeyStyle {
	return {
		dim: (text: string) => theme.fg("dim", text),
		text: (text: string) => theme.fg("text", text),
		muted: (text: string) => theme.fg("muted", text),
		border: (text: string) => theme.fg("borderMuted", text),
		bold: (text: string) => theme.bold(text),
	};
}

export function renderAutocompleteHint(
	entries: readonly EditorAutocompleteHintEntry[],
	width: number,
	keybindings: NavKeybindings = getKeybindings(),
	style: NavKeyStyle = themeNavKeyStyle(),
): string {
	return renderAutocompleteHintLine(entries, width, keybindings, style);
}

export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
		autocompleteHint: (entries, width) => renderAutocompleteHint(entries, width),
	};
}
