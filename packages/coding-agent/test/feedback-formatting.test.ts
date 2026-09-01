import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { parse as parseYaml } from "yaml";
import {
	FEEDBACK_REPOSITORY,
	FEEDBACK_TEMPLATES,
	FeedbackValidationError,
	formatFeedbackDraft,
	NOT_TESTED_WITHOUT_EXTENSIONS,
} from "../src/extensions/feedback/templates.ts";

interface IssueFormField {
	type: string;
	id?: string;
	attributes: { label?: string };
	validations?: { required?: boolean };
}

interface IssueForm {
	labels: string[];
	body: IssueFormField[];
}

function readIssueForm(name: string): IssueForm {
	const path = fileURLToPath(new URL(`../../../.github/ISSUE_TEMPLATE/${name}`, import.meta.url));
	return parseYaml(readFileSync(path, "utf8")) as IssueForm;
}

function comparableFields(form: IssueForm): Array<{ id: string; label: string; required: boolean }> {
	return form.body
		.filter((field) => field.type !== "markdown")
		.map((field) => {
			assert.ok(field.id);
			assert.ok(field.attributes.label);
			return {
				id: field.id,
				label: field.attributes.label,
				required: field.validations?.required === true,
			};
		});
}

// Regression coverage for #2799.
describe("feedback issue template formatting", () => {
	test("matches the shipped issue form labels, order, requiredness, and issue labels", () => {
		for (const [kind, file] of [
			["bug", "bug.yml"],
			["enhancement", "contribution.yml"],
		] as const) {
			const form = readIssueForm(file);
			const template = FEEDBACK_TEMPLATES[kind];
			assert.deepEqual(comparableFields(form), template.fields);
			assert.deepEqual(form.labels, [template.label]);
			assert.equal(template.kind, kind);
			assert.equal(template.repository, FEEDBACK_REPOSITORY);
		}
	});

	test("formats bug fields in exact order while preserving supplied text", () => {
		const result = formatFeedbackDraft({
			kind: "bug",
			title: "  Crash on [paste]  ",
			whatHappened: "  The window vanished.  ",
			stepsToReproduce: "1. Open\n2. Paste  twice",
			expectedBehavior: "Stay open",
			version: "1.2.3-alpha.4",
			nonBuiltinExtensionState: "active",
			extensionFreeReproduction: "unknown",
		});

		assert.deepEqual(result, {
			repository: "bastani-inc/atomic",
			kind: "bug",
			label: "bug",
			title: "  Crash on [paste]  ",
			body: [
				"## What happened?",
				"  The window vanished.  ",
				"## Steps to reproduce",
				"1. Open\n2. Paste  twice",
				"## Expected behavior",
				"Stay open",
				"## Version",
				"1.2.3-alpha.4",
				"## Non-builtin extensions",
				"Active",
				"## Extension-free reproduction",
				NOT_TESTED_WITHOUT_EXTENSIONS,
			].join("\n\n"),
		});
	});

	test("renders every extension and atomic -ne status without upgrading unknown evidence", () => {
		for (const [extensionState, extensionText] of [
			["active", "Active"],
			["inactive", "Inactive"],
			["unknown", "Unknown"],
		] as const) {
			for (const [reproduction, reproductionText] of [
				["reproduced", "Reproduced without extensions"],
				["not-reproduced", "Not reproduced without extensions"],
				["unknown", NOT_TESTED_WITHOUT_EXTENSIONS],
			] as const) {
				const result = formatFeedbackDraft({
					kind: "bug",
					title: "Status report",
					whatHappened: "Observed",
					stepsToReproduce: "Run Atomic",
					nonBuiltinExtensionState: extensionState,
					extensionFreeReproduction: reproduction,
				});
				assert.match(result.body, new RegExp(`## Non-builtin extensions\\n\\n${extensionText}`));
				assert.match(result.body, new RegExp(`## Extension-free reproduction\\n\\n${reproductionText}`));
			}
		}
	});

	test("keeps optional fields optional and preserves an explicitly supplied empty value", () => {
		const omitted = formatFeedbackDraft({
			kind: "enhancement",
			title: "New command",
			whatToChange: "Add it",
			why: "It saves time",
		});
		assert.equal(omitted.body, "## What do you want to change?\n\nAdd it\n\n## Why?\n\nIt saves time");

		const suppliedEmpty = formatFeedbackDraft({
			kind: "enhancement",
			title: "New command",
			whatToChange: "Add it",
			why: "It saves time",
			how: "",
		});
		assert.equal(
			suppliedEmpty.body,
			"## What do you want to change?\n\nAdd it\n\n## Why?\n\nIt saves time\n\n## How? (optional)\n\n",
		);
	});

	test("rejects blank required fields without promoting optional fields", () => {
		assert.throws(
			() =>
				formatFeedbackDraft({
					kind: "bug",
					title: "  ",
					whatHappened: "Observed",
					stepsToReproduce: "\n\t",
					nonBuiltinExtensionState: "unknown",
					extensionFreeReproduction: "unknown",
				}),
			(error: Error) => {
				assert.ok(error instanceof FeedbackValidationError);
				assert.deepEqual(error.missingFields, ["title", "Steps to reproduce"]);
				return true;
			},
		);
		assert.doesNotThrow(() =>
			formatFeedbackDraft({
				kind: "bug",
				title: "Bug",
				whatHappened: "Observed",
				stepsToReproduce: "Run Atomic",
				nonBuiltinExtensionState: "inactive",
				extensionFreeReproduction: "not-reproduced",
			}),
		);
	});

	test("rejects missing required fields and unsupported kinds at the runtime boundary", () => {
		assert.throws(
			() =>
				formatFeedbackDraft({
					kind: "bug",
					title: "Bug",
					nonBuiltinExtensionState: "unknown",
					extensionFreeReproduction: "unknown",
				} as Parameters<typeof formatFeedbackDraft>[0]),
			(error: Error) => {
				assert.ok(error instanceof FeedbackValidationError);
				assert.deepEqual(error.missingFields, ["What happened?", "Steps to reproduce"]);
				return true;
			},
		);
		assert.throws(
			() => formatFeedbackDraft({ kind: "incident", title: "Other" } as never),
			(error: Error) => {
				assert.ok(error instanceof FeedbackValidationError);
				assert.deepEqual(error.missingFields, ["kind"]);
				return true;
			},
		);
	});

	test("ignores forbidden attachment and transcript-shaped extra input", () => {
		const result = formatFeedbackDraft({
			kind: "enhancement",
			title: "Safe title",
			whatToChange: "Safe change",
			why: "Safe reason",
			transcript: "forbidden transcript",
			screenshot: "forbidden screenshot",
			artifact: "forbidden artifact",
		} as Parameters<typeof formatFeedbackDraft>[0] & Record<"transcript" | "screenshot" | "artifact", string>);
		assert.doesNotMatch(result.body, /forbidden/);
		assert.deepEqual(Object.keys(result), ["repository", "kind", "label", "title", "body"]);
	});
});
