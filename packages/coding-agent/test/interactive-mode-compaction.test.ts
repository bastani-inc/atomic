import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { CompactionBoundaryMessageComponent } from "../src/modes/interactive/components/compaction-boundary-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { theme } from "../src/modes/interactive/theme/theme.ts";


beforeAll(() => initTheme("dark"));
describe("compaction boundary component", () => {
	it("renders the exact collapsed summary and expanded verbatim marker text", () => {
		const component = new CompactionBoundaryMessageComponent({
			compactedText: "[User]: retained\n(filtered 1 lines)",
			firstKeptEntryId: "m2",
			tokensBefore: 100,
			parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "task" },
			promptVersion: 2,
			rung: "standard",
			stats: { linesBefore: 4, linesDeleted: 1, linesKept: 3, rangeCount: 1, tokensBefore: 100, tokensAfter: 50, percentReduction: 50 },
		});
		const collapsed = stripVTControlCharacters(component.render(200).join("\n"));
		expect(collapsed).toContain("✻ Context compacted · kept 3/4 lines · 50% tokens · standard");
		expect(collapsed).not.toContain("retained");

		component.setExpanded(true);
		const expandedRaw = component.render(200).join("\n");
		const expanded = stripVTControlCharacters(expandedRaw).split("\n").map((line) => line.trimEnd()).join("\n");
		expect(expanded).toContain("[User]: retained\n (filtered 1 lines)");
		expect(expandedRaw).toContain(theme.fg("dim", "(filtered 1 lines)"));
	});
});
