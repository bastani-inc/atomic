import { type Color, foregroundAnsi, mixColors, parseColor, Text, type TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { ExtensionSelectorComponent } from "./extension-selector.ts";

const RADIUS_COLORS: readonly Color[] = ["#4d9abf", "#83ccd2", "#f1be57", "#f09082"].map((hex) => parseColor(hex));
const CHARS_PER_COLOR = 4;
const CHARS_PER_SECOND = 10;
const ANIMATION_FRAME_MS = 50;

export type RadiusLoginOption = { label: string; text: string };

export function radiusShimmer(text: string, elapsedMs: number): string {
	const mode = theme.getColorMode();
	const cycle = RADIUS_COLORS.length * CHARS_PER_COLOR;
	const offset = (elapsedMs / 1000) * CHARS_PER_SECOND;
	let result = "";
	let index = 0;
	for (const char of text) {
		const position = (((index - offset) % cycle) + cycle) % cycle;
		const band = Math.floor(position / CHARS_PER_COLOR);
		const t = position / CHARS_PER_COLOR - band;
		const amount = t * t * (3 - 2 * t);
		const from = RADIUS_COLORS[band] as Color;
		const to = RADIUS_COLORS[(band + 1) % RADIUS_COLORS.length] as Color;
		result += foregroundAnsi(mixColors(from, to, amount, "srgb"), mode) + char;
		index++;
	}
	return `${result}\x1b[39m`;
}

class RadiusLoginMenuComponent extends ExtensionSelectorComponent {
	private readonly radiusOption: RadiusLoginOption;
	private readonly animationStart = performance.now();
	private animationTimer: ReturnType<typeof setInterval> | undefined;
	private animating = false;

	constructor(
		tui: TUI,
		title: string,
		options: string[],
		radiusOption: RadiusLoginOption,
		onSelect: (option: string) => void,
		onCancel: () => void,
	) {
		super(
			title,
			options,
			(option) => {
				this.stopAnimation();
				onSelect(option);
			},
			() => {
				this.stopAnimation();
				onCancel();
			},
		);
		this.radiusOption = radiusOption;
		this.animationTimer = setInterval(() => {
			if (this.animating) tui.requestRender();
		}, ANIMATION_FRAME_MS);
		this.animationTimer.unref?.();
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		const { label, text } = this.radiusOption;
		const selectedLine = new Text(theme.fg("accent", "→ ") + theme.fg("accent", label), 1, 0).render(width)[0];
		const index = selectedLine === undefined ? -1 : lines.indexOf(selectedLine);
		this.animating = index >= 0;
		if (this.animating) {
			const shimmer = radiusShimmer(text, performance.now() - this.animationStart);
			const animatedLine = theme.fg("accent", "→ ") + shimmer + label.slice(text.length);
			lines[index] = new Text(animatedLine, 1, 0).render(width)[0] ?? "";
		}
		return lines;
	}

	private stopAnimation(): void {
		clearInterval(this.animationTimer);
		this.animationTimer = undefined;
		this.animating = false;
	}

	override dispose(): void {
		this.stopAnimation();
		super.dispose();
	}
}

export function createLoginMenuSelector(
	tui: TUI,
	title: string,
	options: string[],
	radiusOption: RadiusLoginOption,
	onSelect: (option: string) => void,
	onCancel: () => void,
): ExtensionSelectorComponent {
	return new RadiusLoginMenuComponent(tui, title, options, radiusOption, onSelect, onCancel);
}
