import { getKeybindings, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { renderTodoResult } from "../src/core/tools/todos-render.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.ts";
import { CompactionBoundaryMessageComponent } from "../src/modes/interactive/components/compaction-boundary-message.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const previousKeybindings = getKeybindings();

function noExpandAffordance(text: string): void {
	expect(text).not.toMatch(/\(\s*(?:(?:Expand|Collapse|to expand)\s*)?\)/);
	expect(text).not.toMatch(/\b(?:Expand|Collapse|to expand)\b/);
}

function bashTui(): TUI {
	return {
		terminal: { columns: 120, rows: 40 },
		addInterval: () => ({ dispose: () => {} }),
		removeInterval: () => {},
		requestRender: () => {},
	} as unknown as TUI;
}

beforeAll(() => initTheme("dark"));

afterEach(() => {
	setKeybindings(previousKeybindings);
});

describe("unbound expandable message hints", () => {
	test("skill, branch, and compaction headers omit unavailable parentheticals", () => {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": [] }));
		const skill = new SkillInvocationMessageComponent({ name: "tmux", location: "/tmp/tmux/SKILL.md", content: "skill body" });
		const branch = new BranchSummaryMessageComponent({ role: "branchSummary", summary: "branch body", fromId: "entry-1" });
		const compaction = new CompactionBoundaryMessageComponent({
			text: "compacted body",
			stats: { linesBefore: 10, linesDeleted: 5, linesKept: 5, rangeCount: 1, tokensBefore: 100, tokensAfter: 50, percentReduction: 50 },
			rung: "planned",
		});

		for (const target of [skill, branch, compaction]) noExpandAffordance(stripAnsi(target.render(120).join("\n")));
		skill.setExpanded(true);
		branch.setExpanded(true);
		compaction.setExpanded(true);
		expect(stripAnsi(skill.render(120).join("\n"))).toContain("skill body");
		expect(stripAnsi(branch.render(120).join("\n"))).toContain("branch body");
		expect(stripAnsi(compaction.render(120).join("\n"))).toContain("compacted body");
	});

	test("bash and todo collapsed output omit unavailable shortcut rows", () => {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": [] }));
		const bash = new BashExecutionComponent("printf output", bashTui());
		bash.appendOutput(Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join("\n"));
		bash.setComplete(0, false);
		const collapsedBash = stripAnsi(bash.render(120).join("\n"));
		expect(collapsedBash).toContain("line 25");
		noExpandAffordance(collapsedBash);

		const todo = renderTodoResult({
			content: [{ type: "text", text: "todo" }],
			details: {
				action: "get",
				todo: { id: "abcdef12", title: "Investigate", tags: [], status: "open", created_at: "2026-07-17", body: "details" },
			},
		}, { expanded: false, isPartial: false }, theme);
		const collapsedTodo = stripAnsi(todo.render(120).join("\n"));
		expect(collapsedTodo).toContain("Investigate");
		noExpandAffordance(collapsedTodo);
	});
});
