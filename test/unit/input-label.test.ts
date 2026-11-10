import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { CustomEditor } from "../../packages/coding-agent/src/modes/interactive/components/custom-editor.js";
import {
	applyInputLabelToEditorTopRule,
	INPUT_LABEL_MIN_COLUMNS,
	type InputLabelStyle,
} from "../../packages/coding-agent/src/modes/interactive/components/input-label.js";
import { getEditorTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { applyStageLabelToEditorTopRule } from "../../packages/workflows/src/tui/stage-input-label.js";
import { makeTestTui } from "../support/fake-tui.js";

const MUTED = "\x1b[90m";
const TEXT = "\x1b[97m";
const OFF = "\x1b[39m";
const style: InputLabelStyle = {
	textMuted: (text) => `${MUTED}${text}${OFF}`,
	text: (text) => `${TEXT}${text}${OFF}`,
};
const RULE_COLOR = "\x1b[38;2;1;2;3m";
const rule = (width: number) => `${RULE_COLOR}${"─".repeat(width)}\x1b[0m`;
const plain = (line: string | undefined) => stripVTControlCharacters(line ?? "");
const labels = (lines: readonly string[]) => (plain(lines.join("\n")).match(/\[subagent:/g) ?? []).length;

describe("the shared chat input label (#4640)", () => {
	test("labels a wide editor's top rule with muted brackets and a bold name, keeping its width and colour (#4640)", () => {
		const content = "❯ hello";
		const source = [rule(80), content, rule(80)];
		const output = applyInputLabelToEditorTopRule(style, "subagent", "subagent-worker-aabcf28b-1", source);
		assert.equal(plain(output[0]), `[subagent: subagent-worker-aabcf28b-1] ${"─".repeat(41)}`);
		assert.equal(visibleWidth(output[0] ?? ""), 80);
		assert.ok(output[0]?.startsWith(RULE_COLOR), "the rule keeps its colour before the label");
		assert.ok(output[0]?.includes(`${MUTED}[subagent: ${OFF}`), "the opening bracket and kind are muted");
		assert.ok(output[0]?.includes(`\x1b[1m${TEXT}subagent-worker-aabcf28b-1${OFF}\x1b[22m`), "the name is bold");
		assert.ok(output[0]?.includes(`${MUTED}] ${OFF}`), "the closing bracket is muted");
		assert.ok(output[0]?.includes(`${RULE_COLOR}${"─".repeat(41)}`), "the rest of the rule keeps its colour");
		assert.deepEqual(output.slice(1), source.slice(1), "only the top rule changes");
		assert.equal(source[0], rule(80), "the rendered lines are not modified in place");
	});

	test("leaves rules narrower than 40 columns unlabeled and labels a rule of exactly 40 (#4640)", () => {
		assert.equal(INPUT_LABEL_MIN_COLUMNS, 40);
		const narrow = [rule(39), "❯ x", rule(39)];
		assert.deepEqual(applyInputLabelToEditorTopRule(style, "subagent", "worker", narrow), narrow);
		const floor = applyInputLabelToEditorTopRule(style, "subagent", "worker", [rule(40), "❯ x", rule(40)]);
		assert.equal(plain(floor[0]), `[subagent: worker] ${"─".repeat(21)}`);
	});

	test("truncates a long or wide name with an ellipsis so the rule keeps its width (#4640)", () => {
		const long = applyInputLabelToEditorTopRule(style, "subagent", "x".repeat(60), [rule(40), "❯"]);
		assert.equal(plain(long[0]), `[subagent: ${"x".repeat(24)}…] ──`);
		assert.equal(visibleWidth(long[0] ?? ""), 40);
		const wide = applyInputLabelToEditorTopRule(style, "subagent", "审查-é-👩‍💻-".repeat(6), [rule(44), "❯"]);
		assert.match(plain(wide[0]), /^\[subagent: .+…\] ─*$/);
		assert.equal(visibleWidth(plain(wide[0])), 44);
		const fits = applyInputLabelToEditorTopRule(style, "subagent", "审查-é-👩‍💻", [rule(60), "❯"]);
		assert.match(plain(fits[0]), /^\[subagent: 审查-é-👩‍💻\] ─+$/);
		assert.equal(visibleWidth(plain(fits[0])), 60);
	});

	test("keeps the scrolled `↑ N more` indicator and puts the label in the rule's leading run (#4640)", () => {
		const overflow = " ↑ 5 more ";
		const top = `${RULE_COLOR}${"─".repeat(30)}${overflow}${"─".repeat(80 - 30 - visibleWidth(overflow))}\x1b[0m`;
		const output = applyInputLabelToEditorTopRule(style, "subagent", "worker", [top, "❯ line 0", rule(80)]);
		const labeled = plain(output[0]);
		assert.equal(labeled, `[subagent: worker] ${"─".repeat(25)} ↑ 5 more ${"─".repeat(26)}`);
		assert.equal(visibleWidth(labeled), 80);
		assert.equal(output[2], rule(80), "the bottom rule is never labeled");
		const odd = applyInputLabelToEditorTopRule(style, "subagent", "workers", [top, "❯ line 0"]);
		assert.equal(plain(odd[0]), `[subagent: workers] ${"─".repeat(25)} ↑ 5 more ${"─".repeat(25)}`);
		const cramped = `${"─".repeat(7)} ↑ ${"1".repeat(17)} more ${"─".repeat(7)}`;
		assert.equal(visibleWidth(cramped), 40);
		assert.deepEqual(applyInputLabelToEditorTopRule(style, "subagent", "w", [cramped, "❯"]), [cramped, "❯"]);
		const roomy = `${"─".repeat(7)} ↑ ${"1".repeat(16)} more ${"─".repeat(8)}`;
		const fitted = applyInputLabelToEditorTopRule(style, "subagent", "w", [roomy, "❯"]);
		assert.equal(plain(fitted[0]), `[subagent: w]  ↑ ${"1".repeat(16)} more ─`);
	});

	test("labels a real scrolled editor draft once, on its top rule, with the prompt on the content line (#4640)", () => {
		initTheme("dark");
		const editor = new CustomEditor(makeTestTui(24), getEditorTheme(), new KeybindingsManager());
		editor.setText(Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"));
		const source = editor.render(80);
		assert.match(plain(source[0]), /↑ \d+ more/);
		const output = applyInputLabelToEditorTopRule(style, "subagent", "worker", source);
		assert.match(plain(output[0]), /^\[subagent: worker\] ─+ ↑ \d+ more ─+$/);
		assert.equal(visibleWidth(output[0] ?? ""), 80);
		assert.deepEqual(output.slice(1), source.slice(1));
		assert.equal(labels(output), 1);
	});

	test("adds no second label, ignores draft text that names a label, and skips rules that are not plain (#4640)", () => {
		const once = applyInputLabelToEditorTopRule(style, "subagent", "worker", [rule(80), "❯ x", rule(80)]);
		assert.deepEqual(applyInputLabelToEditorTopRule(style, "subagent", "worker", once), once);
		assert.deepEqual(applyInputLabelToEditorTopRule(style, "subagent", "other", once), once);
		const draft = ["─".repeat(80), "❯ explain [subagent: other]", "─".repeat(80)];
		const labeled = applyInputLabelToEditorTopRule(style, "subagent", "worker", draft);
		assert.equal(plain(labeled[0]), `[subagent: worker] ${"─".repeat(61)}`);
		assert.deepEqual(labeled.slice(1), draft.slice(1));
		for (const top of ["", "❯ not a rule", `${"─".repeat(40)}x`, `╭${"─".repeat(78)}╮`]) {
			assert.deepEqual(applyInputLabelToEditorTopRule(style, "subagent", "worker", [top, "❯"]), [top, "❯"]);
		}
		assert.deepEqual(applyInputLabelToEditorTopRule(style, "subagent", undefined, draft), draft);
		assert.deepEqual(applyInputLabelToEditorTopRule(style, "subagent", "", draft), draft);
		assert.deepEqual(applyInputLabelToEditorTopRule(style, "subagent", "worker", []), []);
	});

	test("one label implementation serves the stage kind too (#4640)", () => {
		const source = [rule(80), "❯ x", rule(80)];
		const stage = applyStageLabelToEditorTopRule({ textMuted: "#888888", text: "#ffffff" }, "review-a", source);
		const shared = applyInputLabelToEditorTopRule(style, "stage", "review-a", source);
		assert.equal(plain(stage[0]), plain(shared[0]));
		assert.equal(plain(stage[0]), `[stage: review-a] ${"─".repeat(62)}`);
		assert.deepEqual(applyInputLabelToEditorTopRule(style, "subagent", "worker", stage), stage);
	});
});
