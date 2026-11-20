import { Box, Container, Spacer, Text } from "@bastani/atomic-tui";
import type {
	CompactionForm,
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
import { keyHintIfBound } from "./keybinding-hints.js";
import { blockRows, type RowRange, rowsFrom } from "./transcript-block-clicks.ts";
import { formatWorkingTokens } from "./working-run-meter.ts";

/** The mark every compaction boundary line starts with. */
export const COMPACTION_BOUNDARY_MARK = "⚛";

interface BoundaryView {
	text: string;
	form: CompactionForm;
	stats: VerbatimCompactionStats;
	/** Who produced the replacement text of a compacted boundary: a compactor model, or an extension. */
	source?: string;
	/** Authoritative whole-context count, preferred for the tokens before the boundary. */
	tokensBefore?: number;
	fallbackReason?: string;
}

/** The one-line notice shown when a configured compactor was not used and the context was cleared instead. */
export function compactionFallbackNotice(reason: string): string {
	return `Compaction model not used (${reason}); context cleared instead`;
}

/** The boundary's title line without styling: `⚛ Context cleared · N tokens` or `⚛ Context compacted · …`. */
export function compactionBoundaryTitle(
	view: Pick<BoundaryView, "form" | "stats" | "source" | "tokensBefore">,
): string {
	if (view.form === "cleared") {
		return `${COMPACTION_BOUNDARY_MARK} Context cleared · ${formatWorkingTokens(view.tokensBefore ?? view.stats.tokensBefore)} tokens`;
	}
	// Both sides come from the same estimate, so the reduction compares like with like (#5243).
	return [
		`${COMPACTION_BOUNDARY_MARK} Context compacted`,
		...(view.source ? [view.source] : []),
		`${formatWorkingTokens(view.stats.tokensBefore)} → ${formatWorkingTokens(view.stats.tokensAfter)} tokens`,
	].join(" · ");
}

/** A boundary written before the clear-and-recover design has no `form`: it kept part of the conversation. */
function legacyForm(details: { form?: CompactionForm; rung?: string }): CompactionForm {
	if (details.form) return details.form;
	return details.rung === "fresh" ? "cleared" : "compacted";
}

function sourceOf(details: { backend?: string; model?: string }): string | undefined {
	if (details.model) return details.model;
	return details.backend === "extension" ? "extension" : undefined;
}

/** Renders a durable compaction boundary: one title line, and the whole boundary message when expanded. */
export class CompactionBoundaryMessageComponent extends Box {
	private expanded = false;
	private readonly view: BoundaryView;

	constructor(result: VerbatimCompactionResult | BoundaryView, outputPad = 1) {
		super(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		if ("compactedText" in result) {
			this.view = {
				text: result.compactedText,
				form: legacyForm(result),
				stats: result.stats,
				tokensBefore: result.tokensBefore,
				...(sourceOf(result) ? { source: sourceOf(result) } : {}),
				...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
			};
		} else {
			this.view = result;
		}
		this.updateDisplay();
	}

	/** A click anywhere on the compaction boundary expands or collapses it, as Ctrl+O does. */
	readonly expandsOnClick = true;

	isExpanded(): boolean {
		return this.expanded;
	}

	/** Its rows: an expand hint in them is part of the block, which a click on it expands or collapses. */
	override render(width: number): string[] {
		return blockRows(super.render(width));
	}

	/** Every row of the compaction boundary, its padding included. */
	clickArea(width: number): RowRange | undefined {
		return rowsFrom(0, this.render(width).length);
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
		const [head = "", ...rest] = compactionBoundaryTitle(this.view).split(" · ");
		const hint = this.expanded ? "" : keyHintIfBound("app.tools.expand", "to expand");
		const label = [
			theme.fg("customMessageLabel", theme.bold(head.slice(COMPACTION_BOUNDARY_MARK.length + 1))),
			...rest.map((part) => theme.fg("customMessageText", part)),
			...(hint ? [hint] : []),
		].join(theme.fg("dim", " · "));
		content.addChild(new Text(`${COMPACTION_BOUNDARY_MARK} ${label}`, 0, 0));
		if (this.view.fallbackReason) {
			content.addChild(new Text(theme.fg("warning", compactionFallbackNotice(this.view.fallbackReason)), 0, 0));
		}
		if (this.expanded) {
			const tokensBefore = (this.view.tokensBefore ?? this.view.stats.tokensBefore).toLocaleString();
			content.addChild(new Spacer(1));
			content.addChild(
				new Text(
					theme.bold(theme.fg("customMessageText", `Context before compaction: ${tokensBefore} tokens`)),
					0,
					0,
				),
			);
			content.addChild(new Spacer(1));
			const rendered = this.view.text
				.split("\n")
				.map((line) =>
					/^\(filtered \d+ lines\)$/.test(line) ? theme.fg("dim", line) : theme.fg("customMessageText", line),
				)
				.join("\n");
			content.addChild(new Text(rendered, 0, 0));
		}
		this.addChild(content);
	}
}

export function compactionBoundaryFromMessage(
	message: CustomMessage,
	expanded: boolean,
	outputPad = 1,
): CompactionBoundaryMessageComponent {
	const details = message.details as Omit<VerbatimCompactionDetails, "backend"> & { rung?: string; backend?: string };
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
	const source = sourceOf(details);
	const component = new CompactionBoundaryMessageComponent(
		{
			text,
			form: legacyForm(details),
			stats: details.stats,
			tokensBefore: details.tokensBefore ?? details.stats.tokensBefore,
			...(source ? { source } : {}),
			...(details.fallbackReason ? { fallbackReason: details.fallbackReason } : {}),
		},
		outputPad,
	);
	component.setExpanded(expanded);
	return component;
}
