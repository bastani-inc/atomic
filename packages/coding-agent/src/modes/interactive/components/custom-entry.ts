import type { Component } from "@bastani/atomic-tui";
import { Box, Container, Spacer, Text } from "@bastani/atomic-tui";
import type { EntryRenderer } from "../../../core/extensions/types.ts";
import type { CustomEntry } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.js";
import { keyHint, keyText } from "./keybinding-hints.js";
import { declaresHistoryReplayable } from "./renderer-disposal.js";
import { blockRows, type RowRange, rowsFrom, setRendererClickTarget } from "./transcript-block-clicks.ts";

/** Renders an extension-owned persistent session entry. */
export class CustomEntryComponent extends Container {
	readonly selectionTextMayChangeOnReplay = true;
	get historyReplayable(): boolean {
		return declaresHistoryReplayable(this.customComponent);
	}
	private customComponent?: Component;
	private expanded = false;
	private outputPad: number;

	private readonly entry: CustomEntry<unknown>;
	private readonly renderer: EntryRenderer;

	constructor(entry: CustomEntry<unknown>, renderer: EntryRenderer, outputPad = 1) {
		super();
		this.entry = entry;
		this.renderer = renderer;
		setRendererClickTarget(this, { container: this, top: 0, firstRow: 1 });
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

	/** Its rows: an expand hint in them is part of the block, which a click on it expands or collapses. */
	override render(width: number): string[] {
		return blockRows(super.render(width));
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
			component = this.renderer(this.entry, { expanded: this.expanded, keyText, keyHint }, theme);
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
