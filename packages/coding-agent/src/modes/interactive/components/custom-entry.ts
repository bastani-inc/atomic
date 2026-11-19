import type { Component } from "@bastani/atomic-tui";
import { Box, Container, Spacer, Text } from "@bastani/atomic-tui";
import type { EntryRenderer } from "../../../core/extensions/types.ts";
import type { CustomEntry } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.js";
import { keyHint, keyText } from "./keybinding-hints.js";
import { RendererMouseControls } from "./renderer-mouse-controls.js";
import { type RowRange, rowsFrom } from "./transcript-block-clicks.ts";

/** Renders an extension-owned persistent session entry. */
export class CustomEntryComponent extends Container {
	private customComponent?: Component;
	private expanded = false;
	private outputPad: number;

	private readonly controls?: RendererMouseControls;
	private readonly entry: CustomEntry<unknown>;
	private readonly renderer: EntryRenderer;

	constructor(entry: CustomEntry<unknown>, renderer: EntryRenderer, outputPad = 1, localMouseControls = false) {
		super();
		this.entry = entry;
		this.renderer = renderer;
		if (localMouseControls) this.controls = new RendererMouseControls(this, 1);
		this.outputPad = outputPad;
		this.rebuild();
	}

	hasContent(): boolean {
		return this.customComponent !== undefined;
	}

	/** An entry that draws anything expands on a click, as Ctrl+O expands it; its renderer decides what that shows. */
	get expandsOnClick(): boolean {
		return this.customComponent !== undefined;
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	/** Every row of the entry, under the blank row it leads with. */
	clickArea(width: number): RowRange | undefined {
		const [spacer] = this.children;
		if (this.customComponent === undefined || spacer === undefined) return undefined;
		return rowsFrom(spacer.render(width).length, this.render(width).length);
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.rebuild();
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
		this.rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.customComponent = undefined;
		let component: Component | undefined;
		try {
			const options = { expanded: this.expanded, keyText, keyHint };
			component = this.controls
				? this.controls.render((bindMouseControl) =>
						this.renderer(this.entry, { ...options, bindMouseControl }, theme),
					)
				: this.renderer(this.entry, options, theme);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const box = new Box(this.outputPad, 1, (text) => theme.bg("customMessageBg", text));
			box.addChild(new Text(theme.fg("error", `[${this.entry.customType}] renderer failed: ${message}`), 0, 0));
			component = box;
		}
		if (!component) return;
		this.customComponent = component;
		this.addChild(new Spacer(1));
		this.addChild(component);
	}
}
