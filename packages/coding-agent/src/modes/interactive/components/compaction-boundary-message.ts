import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import type { VerbatimCompactionDetails, VerbatimCompactionResult, VerbatimCompactionStats } from "../../../core/compaction/index.ts";
import { VERBATIM_COMPACTION_PREFIX, type CustomMessage } from "../../../core/messages.ts";
import { theme } from "../theme/theme.ts";

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
		const { stats } = this.view;
		if (this.expanded) {
			this.addChild(new Text(theme.fg("customMessageLabel", "✻ Context compacted"), 0, 0));
			this.addChild(new Spacer(1));
			const rendered = this.view.text.split("\n").map((line) => /^\(filtered \d+ lines\)$/.test(line) ? theme.fg("dim", line) : theme.fg("customMessageText", line)).join("\n");
			this.addChild(new Text(rendered, 0, 0));
			return;
		}
		const summary = `✻ Context compacted · kept ${stats.linesKept}/${stats.linesBefore} lines · ${formatPercent(stats.percentReduction)} tokens · ${this.view.rung}`;
		this.addChild(new Text(theme.fg("customMessageText", summary), 0, 0));
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

function formatPercent(value: number): string {
	const rounded = Math.round(value * 10) / 10;
	return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}
