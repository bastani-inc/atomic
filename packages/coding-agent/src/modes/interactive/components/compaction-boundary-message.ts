import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import type {
	VerbatimCompactionDetails,
	VerbatimCompactionResult,
	VerbatimCompactionStats,
} from "../../../core/compaction/index.ts";
import { type CustomMessage, VERBATIM_COMPACTION_PREFIX } from "../../../core/messages.ts";
import { theme } from "../theme/theme.ts";
import { parenthesizedKeyHint } from "./keybinding-hints.ts";

interface BoundaryView {
	text: string;
	stats: VerbatimCompactionStats;
	rung: VerbatimCompactionDetails["rung"];
	/**
	 * Authoritative whole-context token count for display, from the
	 * `CompactionEntry.tokensBefore` / `VerbatimCompactionResult.tokensBefore`
	 * field. This is the provider-aware count used for budgeting; it is
	 * deliberately separate from the symmetric heuristic `stats.tokensBefore`
	 * so the "Compacted from N tokens" line shows the best available number
	 * while the reported stats pair remains internally consistent.
	 *
	 * Optional: a caller constructing a `BoundaryView` directly may omit it, in
	 * which case the display falls back to the heuristic `stats.tokensBefore` —
	 * the same fallback `extractDisplayTokensBefore` applies to legacy entries.
	 */
	displayTokensBefore?: number;
}

/** Renders the durable verbatim compaction boundary without markdown reflow. */
export class CompactionBoundaryMessageComponent extends Box {
	private expanded = false;
	private readonly view: BoundaryView;

	constructor(result: VerbatimCompactionResult | BoundaryView) {
		super(1, 1, (text) => theme.bg("customMessageBg", text));
		this.view =
			"compactedText" in result
				? {
						text: result.compactedText,
						stats: result.stats,
						rung: result.rung,
						displayTokensBefore: result.tokensBefore,
					}
				: result;
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
		const tokenStr = (this.view.displayTokensBefore ?? this.view.stats.tokensBefore).toLocaleString();
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
		displayTokensBefore: extractDisplayTokensBefore(details),
	});
	component.setExpanded(expanded);
	return component;
}

/**
 * Extract the authoritative token count for display from persisted details.
 *
 * `createVerbatimCompactionMessage` stores `tokensBefore` in `details` when no
 * explicit details object is supplied. When details are present (the normal
 * verbatim-compaction path), the authoritative count lives on the
 * `CompactionEntry.tokensBefore` field that was passed to `appendCompaction`,
 * which is mirrored in `details.stats` only by the old mixed-unit path. We
 * prefer `details.tokensBefore` (the authoritative budgeting number) and fall
 * back to the stats value for legacy entries.
 */
function extractDisplayTokensBefore(details: VerbatimCompactionDetails): number {
	const detailsRecord = details as VerbatimCompactionDetails & { tokensBefore?: number };
	if (typeof detailsRecord.tokensBefore === "number") return detailsRecord.tokensBefore;
	return details.stats.tokensBefore;
}
