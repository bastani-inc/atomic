import { Box, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { ContextCompactionResult } from "../../../core/compaction/index.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * Component that renders deletion-only context compaction results with the same
 * compact/expanded card treatment as summary compaction messages.
 */
export class ContextCompactionSummaryMessageComponent extends Box {
	private expanded = false;
	private result: ContextCompactionResult;
	private markdownTheme: MarkdownTheme;

	constructor(result: ContextCompactionResult, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.result = result;
		this.markdownTheme = markdownTheme;
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

		const label = theme.fg("customMessageLabel", `\x1b[1m[compaction]\x1b[22m`);
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));

		if (this.expanded) {
			this.addChild(
				new Markdown(this.expandedMarkdown(), 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
			return;
		}

		const stats = this.result.stats;
		const deleted = formatObjectCount(stats.objectsDeleted);
		this.addChild(
			new Text(
				theme.fg(
					"customMessageText",
					`Compacted ${deleted}; est. transcript ${formatInteger(stats.tokensBefore)} → ${formatInteger(stats.tokensAfter)} tokens (${formatPercent(stats.percentReduction)} reduction, `,
				) +
					theme.fg("dim", keyText("app.tools.expand")) +
					theme.fg("customMessageText", " Expand)"),
				0,
				0,
			),
		);
	}

	private expandedMarkdown(): string {
		const stats = this.result.stats;
		const deletedTargets = this.result.deletedTargets.slice(0, 8).map((target) => `  - ${formatTarget(target)}`);
		const remainingTargets = this.result.deletedTargets.length - deletedTargets.length;
		if (remainingTargets > 0) {
			deletedTargets.push(`  - … ${remainingTargets} more`);
		}

		const lines = [
			"**Context compacted**",
			"",
			"Retained transcript content stayed verbatim.",
			"",
			`- Estimated transcript tokens: ${formatInteger(stats.tokensBefore)} → ${formatInteger(stats.tokensAfter)} (${formatPercent(stats.percentReduction)} reduction)`,
			`- Deleted: ${formatObjectCount(stats.objectsDeleted)}`,
			`- Protected: ${this.result.protectedEntryIds.length.toLocaleString()} entr${this.result.protectedEntryIds.length === 1 ? "y" : "ies"}`,
		];

		if (this.result.backupPath) {
			lines.push(`- Backup: \`${this.result.backupPath}\``);
		}

		if (deletedTargets.length > 0) {
			lines.push("", "Deleted targets:", ...deletedTargets);
		}

		return `${lines.join("\n")}\n`;
	}
}

function formatInteger(value: number): string {
	return Math.round(value).toLocaleString();
}

function formatPercent(value: number): string {
	const rounded = Math.round(value * 10) / 10;
	return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function formatObjectCount(count: number): string {
	return `${count.toLocaleString()} object${count === 1 ? "" : "s"}`;
}

function formatTarget(target: ContextCompactionResult["deletedTargets"][number]): string {
	if (target.kind === "entry") {
		return `entry \`${target.entryId}\``;
	}

	const block = target.blockIndex === undefined ? "unknown" : target.blockIndex.toLocaleString();
	return `content block ${block} in \`${target.entryId}\``;
}
