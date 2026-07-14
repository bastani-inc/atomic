import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import type { VerbatimCompactionDetails, VerbatimCompactionResult, VerbatimCompactionStats } from "../../../core/compaction/index.ts";
import { VERBATIM_COMPACTION_PREFIX, type CustomMessage } from "../../../core/messages.ts";
import { theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

interface BoundaryView {
	text: string;
	stats: VerbatimCompactionStats;
	rung: VerbatimCompactionDetails["rung"];
}

/** Renders the durable verbatim compaction boundary without markdown reflow. */
export class CompactionBoundaryMessageComponent extends Box {
	private expanded = false;
	private readonly view: BoundaryView;

	constructor(result: VerbatimCompactionResult | BoundaryView) {
		super(1, 1, (text) => theme.bg("customMessageBg", text));
		this.view = "compactedText" in result
			? { text: result.compactedText, stats: result.stats, rung: result.rung }
			: result;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void { this.expanded = expanded; this.updateDisplay(); }
	override invalidate(): void { super.invalidate(); this.updateDisplay(); }

	private updateDisplay(): void {
		this.clear();
		const tokenStr = this.view.stats.tokensBefore.toLocaleString();
		const label = theme.fg("customMessageLabel", theme.bold("✻ Context compacted"));
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));
		if (this.expanded) {
			this.addChild(new Text(theme.bold(theme.fg("customMessageText", `Compacted from ${tokenStr} tokens`)), 0, 0));
			this.addChild(new Spacer(1));
			const rendered = this.view.text.split("\n").map((line) => /^\(filtered \d+ lines\)$/.test(line) ? theme.fg("dim", line) : theme.fg("customMessageText", line)).join("\n");
			this.addChild(new Text(rendered, 0, 0));
			return;
		}
		this.addChild(
			new Text(
				theme.fg("customMessageText", `Compacted from ${tokenStr} tokens (`) +
					theme.fg("dim", keyText("app.tools.expand")) +
					theme.fg("customMessageText", " to expand)"),
				0,
				0,
			),
		);
	}
}


export function compactionBoundaryFromMessage(message: CustomMessage, expanded: boolean): CompactionBoundaryMessageComponent {
	const details = message.details as VerbatimCompactionDetails;
	const content = Array.isArray(message.content)
		? message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")
		: message.content;
	const component = new CompactionBoundaryMessageComponent({
		text: content.startsWith(VERBATIM_COMPACTION_PREFIX) ? content.slice(VERBATIM_COMPACTION_PREFIX.length) : content,
		stats: details.stats,
		rung: details.rung,
	});
	component.setExpanded(expanded);
	return component;
}
