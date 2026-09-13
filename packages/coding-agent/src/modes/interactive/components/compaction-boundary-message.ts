import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import type {
	VerbatimCompactionDetails,
	VerbatimCompactionResult,
	VerbatimCompactionStats,
} from "../../../core/compaction/index.ts";
import { type CustomMessage, VERBATIM_COMPACTION_PREFIX } from "../../../core/messages.ts";
import { theme } from "../theme/theme.js";
import { parenthesizedKeyHint } from "./keybinding-hints.js";

interface BoundaryView {
	text: string;
	stats: VerbatimCompactionStats;
	rung: VerbatimCompactionDetails["rung"];
	/** Authoritative whole-context count, preferred for "Compacted from N tokens". */
	tokensBefore?: number;
}

/** Renders the durable verbatim compaction boundary without markdown reflow. */
export class CompactionBoundaryMessageComponent extends Box {
	private expanded = false;
	private readonly view: BoundaryView;

	constructor(result: VerbatimCompactionResult | BoundaryView) {
		super(1, 1, (text) => theme.bg("customMessageBg", text));
		if ("compactedText" in result) {
			this.view = {
				text: result.compactedText,
				stats: result.stats,
				rung: result.rung,
				tokensBefore: result.tokensBefore,
			};
		} else {
			this.view = result;
		}
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}
	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();
		const tokenStr = (this.view.tokensBefore ?? this.view.stats.tokensBefore).toLocaleString();
		// The fresh rung destroyed the compactable conversation; say so plainly.
		const label = theme.fg(
			"customMessageLabel",
			theme.bold(this.view.rung === "fresh" ? "✻ Context cleared (compaction degraded)" : "✻ Context compacted"),
		);
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));
		if (this.expanded) {
			this.addChild(new Text(theme.bold(theme.fg("customMessageText", `Compacted from ${tokenStr} tokens`)), 0, 0));
			this.addChild(new Spacer(1));
			const rendered = this.view.text
				.split("\n")
				.map((line) =>
					/^\(filtered \d+ lines\)$/.test(line) ? theme.fg("dim", line) : theme.fg("customMessageText", line),
				)
				.join("\n");
			this.addChild(new Text(rendered, 0, 0));
			return;
		}
		const hint = parenthesizedKeyHint("app.tools.expand", "to expand");
		this.addChild(
			new Text(theme.fg("customMessageText", `Compacted from ${tokenStr} tokens`) + (hint ? ` ${hint}` : ""), 0, 0),
		);
	}
}

export function compactionBoundaryFromMessage(
	message: CustomMessage,
	expanded: boolean,
): CompactionBoundaryMessageComponent {
	const details = message.details as VerbatimCompactionDetails;
	const content = Array.isArray(message.content)
		? message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n")
		: message.content;
	const component = new CompactionBoundaryMessageComponent({
		text: content.startsWith(VERBATIM_COMPACTION_PREFIX) ? content.slice(VERBATIM_COMPACTION_PREFIX.length) : content,
		stats: details.stats,
		rung: details.rung,
		tokensBefore: details.tokensBefore ?? details.stats.tokensBefore,
	});
	component.setExpanded(expanded);
	return component;
}
