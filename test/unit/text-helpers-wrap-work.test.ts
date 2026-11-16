import assert from "node:assert/strict";
import { test, vi } from "vitest";

const widthWork = vi.hoisted(() => ({ chars: 0, calls: 0 }));

vi.mock("@bastani/atomic-tui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@bastani/atomic-tui")>();
	return {
		...actual,
		visibleWidth: (text: string) => {
			widthWork.calls++;
			widthWork.chars += text.length;
			return actual.visibleWidth(text);
		},
	};
});

test("wrapping many short words measures linear text rather than growing lines (#5234)", async () => {
	const { wrapPlainText } = await import("../../packages/workflows/src/tui/text-helpers.js");
	const text = Array.from({ length: 4_000 }, (_, index) => (index % 2 === 0 ? "ab" : "cde")).join(" ");
	widthWork.chars = 0;
	widthWork.calls = 0;
	const rows = wrapPlainText(text, 120);
	assert.equal(rows.join(" "), text);
	assert.ok(widthWork.calls > 0);
	assert.ok(
		widthWork.chars <= text.length * 2,
		`measured ${widthWork.chars} characters in ${widthWork.calls} calls for ${text.length} characters of text`,
	);
});
