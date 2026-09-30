import type { TerminalColors } from "@earendil-works/pi-tui";
import { terminalAppearance } from "./system-theme.js";

let colors: TerminalColors = {};
let pending = false;
let scheme: "dark" | "light" | undefined;
export function setTerminalColors(next: TerminalColors): void {
	colors = { ...next };
	pending = false;
}
export function getTerminalColors(): TerminalColors {
	return colors;
}
export function markTerminalColorsPending(): void {
	pending = true;
}
export function areTerminalColorsPending(): boolean {
	return pending;
}
export function setTerminalColorScheme(next: "dark" | "light" | undefined): void {
	scheme = next;
}
export function detectColorFgBgTheme(env: NodeJS.ProcessEnv = process.env): "dark" | "light" | undefined {
	const background = env.COLORFGBG?.split(";").at(-1)?.trim();
	if (!background || !/^\d+$/.test(background)) return undefined;
	const index = Number(background);
	return index <= 6 || index === 8 ? "dark" : "light";
}
export function detectTerminalTheme(
	reported: TerminalColors = {},
	reportedScheme?: "dark" | "light",
	env: NodeJS.ProcessEnv = process.env,
): "dark" | "light" {
	return reported.background
		? terminalAppearance(reported.background, reported.foreground)
		: (reportedScheme ?? detectColorFgBgTheme(env) ?? "dark");
}
export function getTerminalTheme(): "dark" | "light" {
	return detectTerminalTheme(colors, scheme);
}
