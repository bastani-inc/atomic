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

	test("preserves long numbered prose that is not a Rust backtrace", () => {
		const body = Array.from(
			{ length: 16 },
			(_, index) => `${index + 1}: ordinary reproduction note ${index + 1}`,
		).join("\n");
		const result = scrubFeedbackDraft(draft("Safe", body), { homeDirectories: [] });
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

	test("redacts common Hugging Face and Stripe keys plus URL userinfo across schemes", () => {
		const tokens = [
			`hf_${"a".repeat(34)}`,
			`sk_live_${"b".repeat(24)}`,
			`rk_live_${"c".repeat(24)}`,
			`sk_test_${"d".repeat(24)}`,
		];
		const urls = [
			"HTTPS://synthetic-user:synthetic-pass@example.invalid/path",
			"postgresql://db-user:db-pass@example.invalid/database",
			"ssh://git-user:git-pass@example.invalid/repository",
		];
		const result = scrubFeedbackDraft(draft("Safe", [...tokens, ...urls].join("\n")), { homeDirectories: [] });

		for (const secret of [...tokens, "synthetic-pass", "db-pass", "git-pass"]) {
			assert.doesNotMatch(result.draft.body, new RegExp(secret, "u"));
		}
		assert.match(result.draft.body, /HTTPS:\/\/\[REDACTED\]@example\.invalid\/path/u);
		assert.match(result.draft.body, /postgresql:\/\/\[REDACTED\]@example\.invalid\/database/u);
		assert.deepEqual(
			result.replacements.map((replacement) => replacement.kind),
			["api-token", "api-token", "api-token", "api-token", "url-credentials", "url-credentials", "url-credentials"],
		);
	});

	test("redacts Google, npm, and GitLab token formats with conservative boundaries", () => {
		const tokens = [`AIza${"A".repeat(35)}`, `npm_${"b".repeat(36)}`, `glpat-${"C".repeat(20)}`];
		const safeText = [
			`prefix${tokens[0]}`,
			`prefix${tokens[1]}`,
			`prefix${tokens[2]}`,
			"AIza-short",
			"npm_package_name",
			"glpat-short",
		].join("\n");
		const result = scrubFeedbackDraft(draft("Safe", `${tokens.join("\n")}\n${safeText}`), {
			homeDirectories: [],
		});

		for (const token of tokens) assert.equal(result.draft.body.split(token).length - 1, 1);
		assert.match(result.draft.body, /AIza-short/u);
		assert.match(result.draft.body, /npm_package_name/u);
		assert.match(result.draft.body, /glpat-short/u);
		assert.deepEqual(
			result.replacements.map((replacement) => replacement.kind),
			["api-token", "api-token", "api-token"],
		);
	});

	test("redacts credential assignment names case-insensitively", () => {
		const result = scrubFeedbackDraft(
			draft("Safe", "token=synthetic-lower-token\napi_key=synthetic-lower-key\nPassword = ordinary-secret"),
			{ homeDirectories: [] },
		);

		assert.equal(result.draft.body, "token=[REDACTED]\napi_key=[REDACTED]\nPassword =[REDACTED]");
		assert.deepEqual(
			result.replacements.map((replacement) => replacement.kind),
			["credential-assignment", "credential-assignment", "credential-assignment"],
		);
	});

	test("matches Windows home prefixes across slash styles without crossing path boundaries", () => {
		const result = scrubFeedbackDraft(
			draft(
				"Safe",
				[
					"C:/Users/Alice/project/one.log",
					"C:\\Users\\Alice\\project\\two.log",
					"C:/Users/Aliceville/safe.log",
					"XC:/Users/Alice/safe.log",
				].join("\n"),
			),
			{ homeDirectories: ["C:\\Users\\Alice"] },
		);

		assert.equal(
			result.draft.body,
			"~/project/one.log\n~\\project\\two.log\nC:/Users/Aliceville/safe.log\nXC:/Users/Alice/safe.log",
		);
		assert.deepEqual(
			result.replacements.map((replacement) => replacement.kind),
			["home-directory", "home-directory"],
		);

		const forwardHome = scrubFeedbackDraft(draft("Safe", "c:\\users\\alice\\project\\three.log"), {
			homeDirectories: ["C:/Users/Alice"],
		});
		assert.equal(forwardHome.draft.body, "~\\project\\three.log");
	});

	test("redacts a complete private-key block before truncating output", () => {
		const privateMaterial = "synthetic-private-material-".repeat(30);
		const privateKeyLabel = ["PRIVATE", "KEY"].join(" ");
		const block = [`-----BEGIN ${privateKeyLabel}-----`, privateMaterial, `-----END ${privateKeyLabel}-----`].join(
			"\n",
		);
		const result = scrubFeedbackDraft(draft("Safe", `${"x".repeat(15_950)}${block}`), {
			homeDirectories: [],
		});

		assert.ok(result.draft.body.length <= FEEDBACK_BODY_MAX_CHARACTERS);
		assert.doesNotMatch(
			result.draft.body,
			new RegExp(`BEGIN ${privateKeyLabel}|synthetic-private-material|END ${privateKeyLabel}`, "u"),
		);
		assert.deepEqual(
			result.replacements.map((replacement) => replacement.kind),
			["private-key"],
		);
	});

	test("redacts complete PGP and unterminated PEM private-key blocks through end of field", () => {
		const pgpLabel = ["PGP", "PRIVATE", "KEY", "BLOCK"].join(" ");
		const pgp = [
			"before",
			`-----BEGIN ${pgpLabel}-----`,
			"synthetic-pgp-private-material",
			`-----END ${pgpLabel}-----`,
			"safe prose after complete block",
		].join("\n");
		const complete = scrubFeedbackDraft(draft("Safe", pgp), { homeDirectories: [] });
		assert.equal(complete.draft.body, "before\n[REDACTED PRIVATE KEY]\nsafe prose after complete block");
		assert.deepEqual(
			complete.replacements.map((replacement) => replacement.kind),
			["private-key"],
		);

		for (const label of ["PRIVATE KEY", "OPENSSH PRIVATE KEY", "EC PRIVATE KEY"]) {
			const unterminated = [
				"before",
				`-----BEGIN ${label}-----`,
				"synthetic-private-material",
				"all remaining field text is part of the incomplete block",
			].join("\n");
			const result = scrubFeedbackDraft(draft("Safe", unterminated), { homeDirectories: [] });
			assert.equal(result.draft.body, "before\n[REDACTED PRIVATE KEY]", label);
			assert.deepEqual(
				result.replacements.map((replacement) => replacement.kind),
				["private-key"],
				label,
			);
		}
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

	test("bounds long Rust and Go stacks plus structured JSON and environment diagnostics", () => {
		const rust = Array.from({ length: 16 }, (_, index) =>
			index % 2 === 0 ? `${index}: atomic::module::frame_${index}` : `             at src/main.rs:${index}:5`,
		).join("\n");
		const go = [
			"goroutine 21 [running]:",
			...Array.from({ length: 7 }, (_, index) => [
				`main.frame${index}()`,
				`\t/tmp/main.go:${index + 1} +0x${index + 10}`,
			]).flat(),
		].join("\n");
		const json = [
			"{",
			...Array.from({ length: 14 }, (_, index) => `  "diagnostic_${index}": "synthetic-${index}",`),
			'  "done": true',
			"}",
		].join("\n");
		const environment = Array.from({ length: 14 }, (_, index) => `runtime_field_${index}=synthetic-${index}`).join(
			"\n",
		);
		const result = scrubFeedbackDraft(draft("Safe", [rust, go, json, environment].join("\n\n")), {
			homeDirectories: [],
		});

		assert.doesNotMatch(result.draft.body, /atomic::module|goroutine 21|diagnostic_13|runtime_field_13/u);
		assert.equal(result.draft.body.match(/stack trace bounded/gu)?.length, 2);
		assert.equal(result.draft.body.match(/diagnostic dump omitted/gu)?.length, 2);
		assert.deepEqual(
			result.replacements.map((replacement) => replacement.kind),
			["stack-trace", "stack-trace", "diagnostic-dump", "diagnostic-dump"],
		);
	});

	test("uses named final-output limits and truthful truncation disclosures", () => {
		const result = scrubFeedbackDraft(
			draft("t".repeat(FEEDBACK_TITLE_MAX_CHARACTERS + 100), "b".repeat(FEEDBACK_BODY_MAX_CHARACTERS + 500)),
			{ homeDirectories: [] },
		);

		assert.ok(result.draft.title.length <= FEEDBACK_TITLE_MAX_CHARACTERS);
		assert.ok(result.draft.body.length <= FEEDBACK_BODY_MAX_CHARACTERS);
		assert.match(result.draft.title, /truncated.*privacy-reviewed length/u);
		assert.match(result.draft.body, /truncated.*privacy-reviewed length/u);
		assert.doesNotMatch(`${result.draft.title}\n${result.draft.body}`, /original length/u);
		assert.deepEqual(
			result.replacements.map(({ field, kind }) => ({ field, kind })),
			[
				{ field: "title", kind: "size-limit" },
				{ field: "body", kind: "size-limit" },
			],
		);
	});

	test("enforces final limits after redaction expansion and keeps occurrence disclosures ordered", () => {
		const title = `${"t".repeat(FEEDBACK_TITLE_MAX_CHARACTERS - " TOKEN=x".length)} TOKEN=x`;
		const body = `${"b".repeat(FEEDBACK_BODY_MAX_CHARACTERS - " token=x".length)} token=x`;
		const result = scrubFeedbackDraft(draft(title, body), { homeDirectories: [] });

		assert.ok(result.draft.title.length <= FEEDBACK_TITLE_MAX_CHARACTERS);
		assert.ok(result.draft.body.length <= FEEDBACK_BODY_MAX_CHARACTERS);
		assert.doesNotMatch(`${result.draft.title}\n${result.draft.body}`, /TOKEN=x|token=x/u);
		assert.deepEqual(
			result.replacements.map(({ field, kind }) => ({ field, kind })),
			[
				{ field: "title", kind: "credential-assignment" },
				{ field: "title", kind: "size-limit" },
				{ field: "body", kind: "credential-assignment" },
				{ field: "body", kind: "size-limit" },
			],
		);
		for (const replacement of result.replacements) {
			assert.doesNotMatch(replacement.description, /TOKEN=x|token=x/u);
		}
	});
});
