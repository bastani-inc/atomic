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
		assert.equal(scrubFeedback("safe", "API_KEY=hunter2").body, "API_KEY=[REDACTED]");
		assert.equal(scrubFeedback("safe", "sortkey = name").body, "sortkey = name");
		assert.equal(scrubFeedback("safe", 'hotkey = "ctrl+k"').body, 'hotkey = "[REDACTED]"');
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
	test("redacts unterminated quoted credential assignments", () => {
		const result = scrubFeedback("safe", 'apiKey="sensitive-value');
		assert.equal(result.body, 'apiKey="[REDACTED]"');
		assert.deepEqual(result.replacements, [{ category: "credential-assignment", count: 1 }]);
		assert.doesNotMatch(JSON.stringify(result), /sensitive-value/u);
	});
	test("redacts complete unquoted and escaped credential values", () => {
		const cases = [
			["PASSWORD=p@ssw0rd!", "PASSWORD=[REDACTED]"],
			["TOKEN=abcdef!secret-suffix", "TOKEN=[REDACTED]"],
			[`apiKey="${String.fromCharCode(92)}sensitive-value`, 'apiKey="[REDACTED]"'],
		] as const;
		for (const [input, expected] of cases) {
			const result = scrubFeedback("safe", input);
			assert.equal(result.body, expected);
			assert.deepEqual(result.replacements, [{ category: "credential-assignment", count: 1 }]);
			assert.deepEqual(scrubFeedback(result.title, result.body).replacements, []);
			assert.doesNotMatch(JSON.stringify(result), /p@ssw0rd|secret-suffix|sensitive-value/u);
		}
	});
	test("scrubs username-only URL userinfo without matching query text", () => {
		const result = scrubFeedback("safe", "https://opaque-access-token@example.invalid/path");
		assert.equal(result.body, "https://[REDACTED]@example.invalid/path");
		assert.deepEqual(result.replacements, [{ category: "url-credentials", count: 1 }]);
		const query = scrubFeedback("safe", "https://example.invalid/path?ref=user:pass@evil");
		assert.equal(query.body, "https://example.invalid/path?ref=user:pass@evil");
		assert.deepEqual(query.replacements, []);
	});
	test("keeps prose and delimiters intact while scrubbing short assignments", () => {
		const prose = [
			"The token: expired yesterday",
			"Here is the secret:\nSomething important happened",
			"primary_key = customer_id",
			"foreign key: orders_id",
		];
		for (const input of prose) assert.equal(scrubFeedback("safe", input).body, input);
		const result = scrubFeedback(
			"safe",
			"key=aaaaaaaaaa,key2=bbbbbbbbbb; password=hunt3 PIN_SECRET=1234 GITHUB_TOKEN=abc SECRET=a1b2c",
		);
		assert.equal(
			result.body,
			"key=[REDACTED],key2=[REDACTED]; password=[REDACTED] PIN_SECRET=[REDACTED] GITHUB_TOKEN=[REDACTED] SECRET=[REDACTED]",
		);
		assert.deepEqual(result.replacements, [{ category: "credential-assignment", count: 6 }]);
	});
	test("scrubs line-leading bare credential labels without treating prose as assignments", () => {
		const cases = [
			["password: s3cr3tValue", "password: [REDACTED]"],
			["password = s3cr3tValue", "password = [REDACTED]"],
			["  password: indented-secret", "  password: [REDACTED]"],
			["- token: listed-secret", "- token: [REDACTED]"],
			["1. password: numbered-secret", "1. password: [REDACTED]"],
			[
				"db:\n  user: admin\n  password: s3cr3tValue\n  host: localhost",
				"db:\n  user: admin\n  password: [REDACTED]\n  host: localhost",
			],
			["**Password:** hunter2secret", "**Password:** [REDACTED]"],
			["**API key:** sk-notreal-12345", "**API key:** [REDACTED]"],
			["*token:* abc123xyz", "*token:* [REDACTED]"],
			["`password:` hunter2secret", "`password:` [REDACTED]"],
		] as const;
		for (const [input, expected] of cases) {
			const result = scrubFeedback("safe", input);
			assert.equal(result.body, expected);
			assert.deepEqual(result.replacements, [{ category: "credential-assignment", count: 1 }]);
		}
	});
	test("scrubs hyphenated credential names without broadening ordinary labels", () => {
		const cases = [
			["api-key: secret123abc", "api-key: [REDACTED]"],
			["x-api-key: 9f8a7b6c5d4e3f", "x-api-key: [REDACTED]"],
			["client-secret: oauthsecret123", "client-secret: [REDACTED]"],
			["auth:\n  api-key: secret123abc", "auth:\n  api-key: [REDACTED]"],
			["curl -H 'x-api-key: 9f8a7b6c5d4e' https://a.invalid", "curl -H 'x-api-key: [REDACTED]' https://a.invalid"],
		] as const;
		for (const [input, expected] of cases) {
			const result = scrubFeedback("safe", input);
			assert.equal(result.body, expected);
			assert.deepEqual(result.replacements, [{ category: "credential-assignment", count: 1 }]);
		}
		for (const input of ["The token: expired yesterday", "sortkey = name", "foreign key: orders_id"]) {
			assert.equal(scrubFeedback("safe", input).body, input);
		}
	});
	test("scrubs slash-containing unquoted credential values completely", () => {
		const result = scrubFeedback("safe", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEX");
		assert.equal(result.body, "AWS_SECRET_ACCESS_KEY=[REDACTED]");
		assert.deepEqual(result.replacements, [{ category: "credential-assignment", count: 1 }]);
		assert.doesNotMatch(JSON.stringify(result), /wJalrXUtnFEMI|K7MDENG|bPxRfiCYEX/u);
	});
	test("does not count empty unquoted assignment values as redactions", () => {
		for (const input of [
			"token=/tmp/example/path",
			"password=&next=1",
			"api_key=<your-key-here>",
			"token=}",
			"secret=;",
		]) {
			assert.deepEqual(scrubFeedback("safe", input), { title: "safe", body: input, replacements: [] });
		}
		assert.deepEqual(scrubFeedback("safe", "API_KEY=realsecret1 and log_path_token=/var/log/atomic.log"), {
			title: "safe",
			body: "API_KEY=[REDACTED] and log_path_token=/var/log/atomic.log",
			replacements: [{ category: "credential-assignment", count: 1 }],
		});
	});
	test("preserves delimiters following unquoted credential assignments", () => {
		const cases = [
			[
				"https://x.invalid/p?token=abc123&user=bob&mode=dark",
				"https://x.invalid/p?token=[REDACTED]&user=bob&mode=dark",
				1,
			],
			[
				"curl 'https://a.invalid/?access_token=tok12345&next=/home'",
				"curl 'https://a.invalid/?access_token=[REDACTED]&next=/home'",
				1,
			],
			["?token=a1b2c3&password=d4e5f6&keep=1", "?token=[REDACTED]&password=[REDACTED]&keep=1", 2],
			["token=abc123|piped", "token=[REDACTED]|piped", 1],
			["token=abc<br>more", "token=[REDACTED]<br>more", 1],
		] as const;
		for (const [input, expected, count] of cases) {
			const result = scrubFeedback("safe", input);
			assert.equal(result.body, expected);
			assert.deepEqual(result.replacements, [{ category: "credential-assignment", count }]);
		}
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
