import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "vitest";
import { parse } from "yaml";
import {
	BUG_ISSUE_FIELDS,
	ENHANCEMENT_ISSUE_FIELDS,
	FEEDBACK_REPOSITORY,
	ISSUE_LABELS,
} from "../../packages/feedback/src/index.js";
import { moduleDir, readTextSync } from "../helpers/runtime.js";

// Regression coverage for bastani-inc/atomic#2799.
describe("feedback issue-form contract", () => {
	for (const [file, fields, label] of [
		["bug.yml", BUG_ISSUE_FIELDS, ISSUE_LABELS.bug],
		["contribution.yml", ENHANCEMENT_ISSUE_FIELDS, ISSUE_LABELS.enhancement],
	] as const) {
		test(`${file} matches the formatter contract`, () => {
			const form = parse(
				readTextSync(join(moduleDir(import.meta.url), "../../.github/ISSUE_TEMPLATE", file), "utf8"),
			) as {
				labels: string[];
				body: { type: string; id?: string; attributes: { label?: string }; validations?: { required?: boolean } }[];
			};
			assert.deepEqual(
				form.body
					.filter(({ type }) => type !== "markdown")
					.map(({ id = "", attributes, validations }) => ({
						id,
						label: attributes.label ?? "",
						required: validations?.required ?? false,
					})),
				fields,
			);
			assert.deepEqual([form.labels, FEEDBACK_REPOSITORY], [[label], { owner: "bastani-inc", repo: "atomic" }]);
		});
	}
});
