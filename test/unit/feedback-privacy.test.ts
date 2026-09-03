import assert from "node:assert/strict";
import { homedir } from "node:os";
import { describe, test } from "vitest";
import {
	boundDiagnostic,
	boundStackTrace,
	MAX_DIAGNOSTIC_CHARS,
	MAX_STACK_TRACE_LINES,
	scrubFeedback,
} from "../../packages/feedback/src/index.js";

// Regression coverage for bastani-inc/atomic#2799.
describe("feedback privacy core", () => {
	test("passes safe text unchanged", () => {
		assert.deepEqual(scrubFeedback("A safe title", "Ordinary diagnostic text."), {
			title: "A safe title",
			body: "Ordinary diagnostic text.",
			replacements: [],
		});
	});

	test("scrubs every required category from title and body with safe, idempotent disclosure", () => {
		const secrets = [
			["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"].map((prefix) => prefix + "F".repeat(32)).join(" "),
			`sk-${"x".repeat(32)}`,
			`sk-ant-${"y".repeat(32)}`,
			`AKIA${"Z".repeat(16)}`,
			`API_KEY=${"a1".repeat(20)}`,
			"https://fake-user:fake-pass@example.invalid/path",
			["-----BEGIN", "PRIVATE KEY-----\nsynthetic-key-material\n-----END PRIVATE KEY-----"].join(" "),
			`${homedir()}/project and /Users/example/work`,
		];
		const result = scrubFeedback(secrets[0] as string, secrets.slice(1).join("\n"));
		for (const secret of secrets.slice(0, 7))
			assert.equal(`${result.title}\n${result.body}`.includes(secret as string), false);
		const fired = result.replacements.map(({ category }) => category).join(" ");
		assert.equal(
			fired,
			"private-key url-credentials anthropic-token github-token openai-token aws-access-key credential-assignment home-directory",
		);
		assert.match(result.body, /~\/project and ~\/work/u);
		assert.equal(JSON.stringify(result.replacements).includes("fake-pass"), false);
		assert.deepEqual(scrubFeedback(result.title, result.body).replacements, []);
	});

	test("scrubs every platform's home paths without disclosing account names or rewriting URLs", () => {
		const body =
			"/Users/synthetic-account and /home/synthetic-account/project and C:\\Users\\synthetic-account\\app and c:\\users\\synthetic-account\\app and https://ex.invalid/Users/docs/readme";
		const result = scrubFeedback(homedir(), body);
		assert.equal(result.title, "~");
		assert.equal(result.body, "~ and ~/project and ~\\app and ~\\app and https://ex.invalid/Users/docs/readme");
		const displayed = JSON.stringify(result);
		assert.doesNotMatch(displayed, /synthetic-account/u);
		assert.equal(displayed.includes(homedir()), false);
		const accountName = homedir().split("/").at(-1) ?? homedir();
		assert.equal(displayed.includes(accountName), false);
		assert.deepEqual(result.replacements, [{ category: "home-directory", count: 5 }]);
	});

	test("scrubs prefixed and suffixed credential names and credentials in any URL scheme", () => {
		const secrets = [
			"G".repeat(40),
			"j".repeat(40),
			"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEX",
			"s".repeat(24),
			`${"q".repeat(16)}.${"r".repeat(16)}`,
			"onlypass",
			"tokensecret",
		];
		const body = `{"apiKey": "${secrets[1]}"}\nAWS_SECRET_ACCESS_KEY=${secrets[2]}\naws:\n  secret_access_key: ${secrets[3]}\ntokenizer: HuggingFaceTokenizerFast\npostgres://u:${secrets[4]}@db:5432/a\nredis://:${secrets[5]}@c:6379\ngit+ssh://git:${secrets[6]}@github.com/x.git\napi_key=${secrets[4]}`;
		const result = scrubFeedback(`GEMINI_API_KEY=${secrets[0]}`, body);
		const displayed = `${result.title}\n${result.body}\n${JSON.stringify(result.replacements)}`;
		for (const secret of secrets) assert.equal(displayed.includes(secret), false);
		assert.equal(result.title, "GEMINI_API_KEY=[REDACTED]");
		assert.match(result.body, /\{"apiKey": "\[REDACTED\]"\}/u);
		assert.match(result.body, /secret_access_key: \[REDACTED\]/u);
		assert.match(result.body, /tokenizer: HuggingFaceTokenizerFast[\s\S]*api_key=\[REDACTED\]/u);
		assert.equal(
			JSON.stringify(result.replacements),
			'[{"category":"url-credentials","count":3},{"category":"credential-assignment","count":5}]',
		);
	});

	test("scrubs quoted assignments with punctuation as complete values", () => {
		const body = "apiKey: \"AAAAAAAAAAAAAAAAAAAA.BBBB\"\npassword = 'p@ss.word!;still-secret'";
		const result = scrubFeedback("safe", body);
		assert.equal(result.body, "apiKey: \"[REDACTED]\"\npassword = '[REDACTED]'");
		assert.equal(result.replacements[0]?.category, "credential-assignment");
		assert.equal(result.replacements[0]?.count, 2);
		assert.doesNotMatch(JSON.stringify(result), /AAAAAAAA|p@ss|still-secret/u);
		assert.deepEqual(scrubFeedback(result.title, result.body).replacements, []);
	});

	test("scrubs PGP and truncation-orphaned private-key blocks and bare provider tokens", () => {
		const tokens = [
			`AIzaSy${"C".repeat(33)}`,
			`xoxb-${"1".repeat(20)}`,
			`glpat-${"a".repeat(20)}`,
			`hf_${"a".repeat(24)}`,
		];
		const cut = boundDiagnostic(["-----BEGIN", `PRIVATE KEY-----\n${"M".repeat(MAX_DIAGNOSTIC_CHARS)}`].join(" "));
		const pgp = "-----BEGIN PGP" + " PRIVATE KEY BLOCK-----\nkeymaterial\n-----END PGP PRIVATE KEY BLOCK-----";
		const result = scrubFeedback(tokens.join(" "), `${pgp}\n${cut}`);
		const displayed = `${result.title}\n${result.body}`;
		for (const token of tokens) assert.equal(displayed.includes(token), false);
		assert.equal(result.body, "[REDACTED]\n[REDACTED]");
		assert.doesNotMatch(displayed, /keymaterial|MMMM/u);
		assert.equal(
			JSON.stringify(result.replacements),
			'[{"category":"private-key","count":2},{"category":"provider-token","count":4}]',
		);
	});

	test("bounds diagnostics with count-only truncation notices", () => {
		const stack = boundStackTrace(
			Array.from({ length: MAX_STACK_TRACE_LINES + 5 }, (_, index) => `line ${index}`).join("\n"),
		);
		assert.equal(stack.split("\n").length, MAX_STACK_TRACE_LINES);
		assert.match(stack, /Truncated 6 stack trace lines/u);
		const diagnostic = boundDiagnostic("x".repeat(MAX_DIAGNOSTIC_CHARS + 100));
		assert.equal(diagnostic.length, MAX_DIAGNOSTIC_CHARS);
		assert.match(diagnostic, /Truncated \d+ diagnostic characters/u);
		assert.equal(scrubFeedback("safe", boundDiagnostic(`apiKey="${"\\".repeat(64)}`)).replacements.length, 0);
	});
});
