import { Box, Container, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import type {
	VerbatimCompactionDetails,
	VerbatimCompactionResult,
	VerbatimCompactionStats,
} from "../../../core/compaction/index.ts";
import {
	type CustomMessage,
	SUMMARY_COMPACTION_PREFIX,
	stripVerbatimCompactionPrefix,
} from "../../../core/messages.ts";
import { theme } from "../theme/theme.js";
import { parenthesizedKeyHint } from "./keybinding-hints.js";

interface BoundaryView {
	text: string;
	stats: VerbatimCompactionStats;
	rung: VerbatimCompactionDetails["rung"];
	backend?: VerbatimCompactionDetails["backend"];
	model?: string;
	/** Authoritative whole-context count, preferred for "Compacted from N tokens". */
	tokensBefore?: number;
	releasedRanges?: VerbatimCompactionDetails["releasedRanges"];
}

/** One short line naming the `<keepContext>` spans that lost protection, or undefined when none did. */
function releasedSpansNotice(released: BoundaryView["releasedRanges"]): string | undefined {
	if (!released || released.length === 0) return undefined;
	const duplicates = released.filter((range) => range.reason === "duplicate").length;
	const reasons = [
		...(duplicates > 0 ? [`${duplicates} duplicate`] : []),
		...(released.length > duplicates ? [`${released.length - duplicates} over budget`] : []),
	];
	const noun = released.length === 1 ? "span" : "spans";
	return `Released ${released.length} keepContext ${noun} (${reasons.join(", ")})`;
}

/** Renders the durable verbatim compaction boundary without markdown reflow. */
export class CompactionBoundaryMessageComponent extends Box {
	private expanded = false;
	private readonly view: BoundaryView;

	constructor(result: VerbatimCompactionResult | BoundaryView, outputPad = 1) {
		super(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		if ("compactedText" in result) {
			this.view = {
				text: result.compactedText,
				stats: result.stats,
				rung: result.rung,
				tokensBefore: result.tokensBefore,
				backend: result.backend,
				model: result.model,
				releasedRanges: result.releasedRanges,
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
	setOutputPad(outputPad: number): void {
		this.setPaddingX(outputPad);
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();
		const content = new Container();
		const tokenStr = (this.view.tokensBefore ?? this.view.stats.tokensBefore).toLocaleString();
		// The fresh rung destroyed the compactable conversation; say so plainly.
		const label = theme.fg(
			"customMessageLabel",
			theme.bold(
				this.view.rung === "fresh"
					? "✻ Context cleared (compaction degraded)"
					: this.view.backend === "summary"
						? "✻ Context compacted · summary (fallback)"
						: "✻ Context compacted",
			),
		);
		content.addChild(new Text(label, 0, 0));
		if (this.view.model) content.addChild(new Text(theme.fg("dim", this.view.model), 0, 0));
		const released = releasedSpansNotice(this.view.releasedRanges);
		if (released) content.addChild(new Text(theme.fg("dim", released), 0, 0));
		content.addChild(new Spacer(1));
		if (this.expanded) {
			content.addChild(
				new Text(theme.bold(theme.fg("customMessageText", `Compacted from ${tokenStr} tokens`)), 0, 0),
			);
			content.addChild(new Spacer(1));
			const rendered = this.view.text
				.split("\n")
				.map((line) =>
					/^\(filtered \d+ lines\)$/.test(line) ? theme.fg("dim", line) : theme.fg("customMessageText", line),
				)
				.join("\n");
			content.addChild(new Text(rendered, 0, 0));
		} else {
			const hint = parenthesizedKeyHint("app.tools.expand", "to expand");
			content.addChild(
				new Text(
					theme.fg("customMessageText", `Compacted from ${tokenStr} tokens`) + (hint ? ` ${hint}` : ""),
					0,
					0,
				),
			);
		}
		this.addChild(
			new MouseRegion(content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
	}
}

export function compactionBoundaryFromMessage(
	message: CustomMessage,
	expanded: boolean,
	outputPad = 1,
): CompactionBoundaryMessageComponent {
	const details = message.details as VerbatimCompactionDetails;
	const content = Array.isArray(message.content)
		? message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n")
		: message.content;
	const text =
		details.backend === "summary"
			? content.startsWith(SUMMARY_COMPACTION_PREFIX)
				? content.slice(SUMMARY_COMPACTION_PREFIX.length)
				: content
			: stripVerbatimCompactionPrefix(content);
	const component = new CompactionBoundaryMessageComponent(
		{
			text,
			stats: details.stats,
			rung: details.rung,
			tokensBefore: details.tokensBefore ?? details.stats.tokensBefore,
			backend: details.backend,
			model: details.model,
			releasedRanges: details.releasedRanges,
		},
		outputPad,
	);
	component.setExpanded(expanded);
	return component;
}
