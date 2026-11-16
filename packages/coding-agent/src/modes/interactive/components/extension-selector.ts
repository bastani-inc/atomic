import type { TUI } from "@bastani/atomic-tui";
import { CountdownTimer } from "./countdown-timer.ts";
import { FramedSelector, type SelectorExtraKey } from "./selector.ts";

export interface ExtensionSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onToggleToolsExpanded?: () => void;
	numbered?: boolean;
	initialIndex?: number;
}

/**
 * A picker for `ctx.ui.select` and the built-in choices that reuse it. The first line of `title` is the title; any
 * further lines show dim under it. With a timeout the title counts down and the picker cancels when it runs out.
 */
export class ExtensionSelectorComponent extends FramedSelector<string> {
	private readonly countdown: CountdownTimer | undefined;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		const [heading = "", ...details] = title.split("\n");
		const toggleTools = opts?.onToggleToolsExpanded;
		const extraKeys: SelectorExtraKey<string>[] = toggleTools
			? [{ hint: { action: "app.tools.expand", label: "tool output" }, run: () => toggleTools() }]
			: [];
		const initialIndex =
			opts?.initialIndex === undefined ? undefined : Math.max(0, Math.min(options.length - 1, opts.initialIndex));
		super({
			title: heading,
			subtitle: details.length > 0 ? details.join("\n") : undefined,
			items: options.map((option, index) => ({ id: String(index), value: option, label: option })),
			extraKeys,
			numbered: opts?.numbered,
			initialId: initialIndex === undefined ? undefined : String(initialIndex),
			onSelect: (item) => onSelect(item.value),
			onCancel,
		});
		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(seconds) => this.selector.setTitle(`${heading} (${seconds}s)`),
				onCancel,
			);
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
