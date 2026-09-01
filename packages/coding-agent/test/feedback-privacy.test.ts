import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	FEEDBACK_BODY_MAX_CHARACTERS,
	FEEDBACK_DIAGNOSTIC_MAX_LINES,
	FEEDBACK_TITLE_MAX_CHARACTERS,
	scrubFeedbackDraft,
} from "../src/extensions/feedback/privacy.ts";
import type { FormattedFeedbackDraft } from "../src/extensions/feedback/templates.ts";

function draft(title: string, body: string): FormattedFeedbackDraft {
	return {
		repository: "bastani-inc/atomic",
		kind: "bug",
		label: "bug",
		title,
		body,
	};
}

// Regression coverage for #2799.
describe("feedback final-output privacy review", () => {
	test("preserves ordinary text and sanitized textual reconstructions byte-for-byte", () => {
		const title = "Editor layout is confusing";
		const body = [
			"Short error: TypeError at render()",
			"https://example.com/docs?id=ordinary_identifier",
			"Sanitized textual reconstruction, not a captured screenshot:",
			"```text",
			"[left pane] | [right pane]",
			"```",
			"```mermaid",
			"flowchart LR",
			"  Expected --> Observed",
			"```",
			"Expected: focus stays left",
			"Observed: focus moves right",
		].join("\n");

		const result = scrubFeedbackDraft(draft(title, body), { homeDirectories: [] });
		assert.equal(result.draft.title, title);
		assert.equal(result.draft.body, body);
		assert.deepEqual(result.replacements, []);
	});

	test("scrubs every mandated secret form in title-then-body occurrence order", () => {
		const githubToken = `ghp_${"A".repeat(36)}`;
		const assignedOne = "synthetic-assignment-one";
		const assignedTwo = "synthetic-assignment-two";
		const urlPassword = "synthetic-url-password";
		const privateMaterial = "c3ludGhldGljLXByaXZhdGUta2V5";
		const privateKeyLabel = ["PRIVATE", "KEY"].join(" ");
		const title = `Failure with ${githubToken}`;
		const body = [
			`TOKEN=${assignedOne}`,
			`TOKEN=${assignedTwo}`,
			`https://fake-user:${urlPassword}@example.com/private`,
			`-----BEGIN ${privateKeyLabel}-----`,
			privateMaterial,
			`-----END ${privateKeyLabel}-----`,
			"/Users/alice/project/file.ts",
			"C:\\Users\\Alice\\project\\file.ts",
		].join("\n");

		const result = scrubFeedbackDraft(draft(title, body), {
			homeDirectories: ["/Users/alice", "C:\\Users\\Alice"],
		});

		for (const removed of [githubToken, assignedOne, assignedTwo, urlPassword, privateMaterial, "/Users/alice"]) {
			assert.doesNotMatch(
				`${result.draft.title}\n${result.draft.body}`,
				new RegExp(removed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			);
			assert.doesNotMatch(
				result.replacements.map((replacement) => replacement.description).join("\n"),
				new RegExp(removed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			);
		}
		assert.deepEqual(
			result.replacements.map(({ field, kind }) => ({ field, kind })),
			[
				{ field: "title", kind: "api-token" },
				{ field: "body", kind: "credential-assignment" },
				{ field: "body", kind: "credential-assignment" },
				{ field: "body", kind: "url-credentials" },
				{ field: "body", kind: "private-key" },
				{ field: "body", kind: "home-directory" },
				{ field: "body", kind: "home-directory" },
			],
		);
		assert.match(result.draft.body, /TOKEN=\[REDACTED\]/);
		assert.match(result.draft.body, /https:\/\/\[REDACTED\]@example\.com\/private/);
		assert.match(result.draft.body, /~\/project\/file\.ts/);
		assert.match(result.draft.body, /~\\project\\file\.ts/);
	});

	test("recognizes common API and access token formats without changing short lookalikes", () => {
		const tokens = [
			`github_pat_${"a".repeat(30)}`,
			`sk-proj-${"b".repeat(24)}`,
			`xoxb-${"1".repeat(12)}-${"c".repeat(20)}`,
			`AKIA${"D".repeat(16)}`,
		];
		const body = `${tokens.join("\n")}\nsk-short\nAKIA-SAMPLE`;
		const result = scrubFeedbackDraft(draft("Safe", body), { homeDirectories: [] });

		for (const token of tokens) assert.doesNotMatch(result.draft.body, new RegExp(token));
		assert.match(result.draft.body, /sk-short/);
		assert.match(result.draft.body, /AKIA-SAMPLE/);
		assert.deepEqual(
			result.replacements.map((replacement) => replacement.kind),
			["api-token", "api-token", "api-token", "api-token"],
		);
	});

	test("bounds long traces and diagnostic dumps but keeps short actionable excerpts", () => {
		const shortTrace = "Error: failed\n    at first (app.ts:1:1)\n    at second (app.ts:2:1)";
		const longTrace = Array.from(
			{ length: FEEDBACK_DIAGNOSTIC_MAX_LINES + 5 },
			(_, index) => `    at frame${index} (app.ts:${index + 1}:1)`,
		).join("\n");
		const dump = Array.from(
			{ length: FEEDBACK_DIAGNOSTIC_MAX_LINES + 4 },
			(_, index) => `DIAGNOSTIC_${index}=synthetic-${index}`,
		).join("\n");
		const body = `${shortTrace}\n\n${longTrace}\n\n${dump}`;
		const result = scrubFeedbackDraft(draft("Safe", body), { homeDirectories: [] });

		assert.match(result.draft.body, new RegExp(shortTrace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(result.draft.body, /stack trace bounded/);
		assert.match(result.draft.body, /diagnostic dump omitted/);
		assert.doesNotMatch(result.draft.body, /frame16/);
		assert.doesNotMatch(result.draft.body, /DIAGNOSTIC_15=/);
		assert.deepEqual(
			result.replacements.map((replacement) => replacement.kind),
			["stack-trace", "diagnostic-dump"],
		);
	});

	test("uses named final-output limits and truthful truncation disclosures", () => {
		const result = scrubFeedbackDraft(
			draft("t".repeat(FEEDBACK_TITLE_MAX_CHARACTERS + 100), "b".repeat(FEEDBACK_BODY_MAX_CHARACTERS + 500)),
			{ homeDirectories: [] },
		);

		assert.ok(result.draft.title.length <= FEEDBACK_TITLE_MAX_CHARACTERS);
		assert.ok(result.draft.body.length <= FEEDBACK_BODY_MAX_CHARACTERS);
		assert.match(result.draft.title, /truncated/);
		assert.match(result.draft.body, /truncated/);
		assert.deepEqual(
			result.replacements.map(({ field, kind }) => ({ field, kind })),
			[
				{ field: "title", kind: "size-limit" },
				{ field: "body", kind: "size-limit" },
			],
		);
	});
});
