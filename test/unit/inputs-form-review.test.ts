import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { coerceValues } from "../../packages/workflows/src/tui/inputs-picker-types.js";
import { renderSubmitReview } from "../../packages/workflows/src/tui/submit-pane.js";

test("boolean review matches submitted aliases with surrounding control whitespace (#5245)", () => {
	const fields = [{ name: "dry_run", type: "boolean", required: true }];
	for (const raw of ["on\r", "TRUE\t", " 1\n"]) {
		assert.deepEqual(coerceValues(fields, { dry_run: raw }), { dry_run: true });
		const review = stripVTControlCharacters(
			renderSubmitReview({
				workflowName: "deploy",
				fields,
				rawText: { dry_run: raw },
				theme: deriveGraphTheme({}),
				width: 80,
			}).join("\n"),
		);
		assert.match(review, /\bon\b/);
		assert.doesNotMatch(review, /\boff\b/);
	}
});
