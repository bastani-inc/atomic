import type { Component } from "@earendil-works/pi-tui";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { EntryRenderer } from "../../../core/extensions/types.ts";
import type { CustomEntry } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.js";

/** Renders an extension-owned persistent session entry. */
export class CustomEntryComponent extends Container {
	private customComponent?: Component;
	private expanded = false;
	private outputPad: number;

	private readonly entry: CustomEntry<unknown>;
	private readonly renderer: EntryRenderer;

	constructor(entry: CustomEntry<unknown>, renderer: EntryRenderer, outputPad = 1) {
		super();
		this.entry = entry;
		this.renderer = renderer;
		this.outputPad = outputPad;
		this.rebuild();
	}

	hasContent(): boolean {
		return this.customComponent !== undefined;
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
			component = this.renderer(this.entry, { expanded: this.expanded }, theme);
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
