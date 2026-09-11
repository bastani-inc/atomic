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

const MARKER_SCAN_TIMEOUT_MS = 250;

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
	test("bounds unterminated quotes and scrubs placeholder suffixes", () => {
		const report = [
			"### What happened?",
			"",
			'The CLI printed apiKey="secret and then stopped.',
			"",
			"### Steps to reproduce",
			"",
			"1. Run atomic",
			"",
			"### Expected behavior",
			"",
			"The session continues.",
		].join("\n");
		const reportResult = scrubFeedback("safe", report);
		assert.match(reportResult.body, /### Steps to reproduce[\s\S]*### Expected behavior/u);
		assert.doesNotMatch(reportResult.body, /apiKey="secret/u);
		for (const input of [`API_KEY=\${VAR}realsecret1`, `API_KEY=\${VAR}-realsecret1`]) {
			const result = scrubFeedback("safe", input);
			assert.equal(result.body, `API_KEY=\${VAR}[REDACTED]`);
			assert.deepEqual(result.replacements, [{ category: "credential-assignment", count: 1 }]);
			assert.doesNotMatch(JSON.stringify(result), /realsecret1|\[REDACTED\]\}/u);
		}
		assert.equal(scrubFeedback("safe", `token=\${TOKEN}`).body, `token=\${TOKEN}`);
		assert.equal(scrubFeedback("safe", "token={{ secrets.TOKEN }}").body, "token={{ secrets.TOKEN }}");
	});
	test("bounds quoted assignments at structural report boundaries", () => {
		const cases = [
			[
				['apiKey="firstSecretAAA', "", "### Logs", "", 'API_KEY="secondSecretBBB"'].join("\n"),
				['apiKey="[REDACTED]"', "", "### Logs", "", 'API_KEY="[REDACTED]"'].join("\n"),
				2,
			],
			[
				["password='hunter2", "", "### Steps to reproduce", "", "It doesn't repeat."].join("\n"),
				["password='[REDACTED]'", "", "### Steps to reproduce", "", "It doesn't repeat."].join("\n"),
				1,
			],
			[
				['apiKey="firstpart\nsecondpartSECRET"', "", "### Logs", "", 'TOKEN="thirdSecret"'].join("\n"),
				['apiKey="[REDACTED]"', "", "### Logs", "", 'TOKEN="[REDACTED]"'].join("\n"),
				2,
			],
			[
				['apiKey="firstpart\nsecondpartSECRET"', "### Logs", 'TOKEN="thirdSecret"'].join("\n"),
				['apiKey="[REDACTED]"', "### Logs", 'TOKEN="[REDACTED]"'].join("\n"),
				2,
			],
			[
				['apiKey="firstpart\nsecondpartSECRET', "", "### Logs", "", 'TOKEN="thirdSecret"'].join("\n"),
				['apiKey="[REDACTED]"', "", "### Logs", "", 'TOKEN="[REDACTED]"'].join("\n"),
				2,
			],
		] as const;
		for (const [input, expected, count] of cases) {
			const result = scrubFeedback("safe", input);
			assert.equal(result.body, expected);
			assert.deepEqual(result.replacements, [{ category: "credential-assignment", count }]);
			assert.deepEqual(scrubFeedback(result.title, result.body).replacements, []);
			assert.doesNotMatch(JSON.stringify(result), /firstSecretAAA|secondSecretBBB|hunter2|thirdSecret/u);
		}
	});
	test("bounds ambiguous multiline quotes without losing later feedback", () => {
		const cases = [
			[
				'apiKey="firstSecretAAA\nNote: password="secondSecretBBB"',
				'apiKey="[REDACTED]"\nNote: password="[REDACTED]"',
				2,
			],
			[
				'apiKey="firstSecretAAA\n\n### Logs\n\nAPI_KEY="secondSecretBBB"',
				'apiKey="[REDACTED]"\n\n### Logs\n\nAPI_KEY="[REDACTED]"',
				2,
			],
			['PRIVATE_TOKEN="lineOneAAAA\n\nlineTwoBBBB"', 'PRIVATE_TOKEN="[REDACTED]"', 1],
			['apiKey="lineOneAAAA\nlineTwoBBBB"\n\n### Logs', 'apiKey="[REDACTED]"\n\n### Logs', 1],
			["password='hunter2SECRET\nIt doesn't repeat.", "password='[REDACTED]'\nIt doesn't repeat.", 1],
		] as const;
		for (const [input, expected, count] of cases) {
			const result = scrubFeedback("safe", input);
			assert.equal(result.body, expected);
			assert.deepEqual(result.replacements, [{ category: "credential-assignment", count }]);
			assert.equal((result.body.match(/"/gu)?.length ?? 0) % 2, 0);
			assert.deepEqual(scrubFeedback(result.title, result.body).replacements, []);
		}
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
	test("preserves emphasized prose and complete wrapper boundaries", () => {
		for (const input of [
			"The token: *expired* yesterday",
			"The secret: **not set** in CI",
			"foreign key: *orders_id* column",
			"primary_key = *customer_id* here",
			"Here is the secret: `none` today",
		]) {
			assert.deepEqual(scrubFeedback("safe", input), { title: "safe", body: input, replacements: [] });
		}
		assert.equal(
			scrubFeedback("safe", "API_KEY: **realsecret1 and notes**").body,
			"API_KEY: **[REDACTED] and notes**",
		);
	});
	test("scrubs credential labels in comments without corrupting prose templates", () => {
		for (const input of [
			"password: field is not masked in the TUI",
			"token: counts are wrong in the footer",
			"key: value pairs are parsed by the YAML loader",
			"1. password: prompts appear twice",
			`token=\${TOKEN}`,
			"token={{ secrets.TOKEN }}",
		]) {
			assert.deepEqual(scrubFeedback("safe", input), { title: "safe", body: input, replacements: [] });
		}
		for (const [input, expected] of [
			["> password: quotedSecret99", "> password: [REDACTED]"],
			["# password: hashSecret99", "# password: [REDACTED]"],
			["// password: slashSecret99", "// password: [REDACTED]"],
			["password=/hunter2slash", "password=[REDACTED]"],
			["SECRET=/hunter2slash", "SECRET=[REDACTED]"],
			['apiKey="firstpart\nsecondpartSECRET"', 'apiKey="[REDACTED]"'],
			["> DB_PASSWORD: quotedSecret99", "> DB_PASSWORD: [REDACTED]"],
			["AWS_SECRET_ACCESS_KEY=/hunter2slash", "AWS_SECRET_ACCESS_KEY=[REDACTED]"],
		] as const) {
			const result = scrubFeedback("safe", input);
			assert.equal(result.body, expected);
			assert.deepEqual(result.replacements, [{ category: "credential-assignment", count: 1 }]);
		}
	});
	test("bounds marker-only credential candidates", () => {
		const input = "*".repeat(32_000);
		const started = performance.now();
		assert.equal(scrubFeedback("safe", input).body, input);
		assert.ok(performance.now() - started < MARKER_SCAN_TIMEOUT_MS);
	});
	test("does not leak punctuation-adjacent credential tails or strong leading-slash values", () => {
		for (const [input, expected] of [
			["PASSWORD=p@ss'word-tail", "PASSWORD=[REDACTED]"],
			['DB_PASSWORD=abc"def-tail', "DB_PASSWORD=[REDACTED]"],
			["API_KEY=abc`def-tail", "API_KEY=[REDACTED]"],
			["AWS_SECRET_ACCESS_KEY=/K7MDENG/bPxRfiCYEX", "AWS_SECRET_ACCESS_KEY=[REDACTED]"],
			["token=/tmp/example/path", "token=/tmp/example/path"],
			["log_path_token=/var/log/atomic.log", "log_path_token=/var/log/atomic.log"],
		] as const) {
			const result = scrubFeedback("safe", input);
			assert.equal(result.body, expected);
			if (expected.includes("[REDACTED]")) {
				assert.deepEqual(result.replacements, [{ category: "credential-assignment", count: 1 }]);
				assert.doesNotMatch(JSON.stringify(result), /word-tail|def-tail|K7MDENG|bPxRfiCYEX/u);
			} else assert.deepEqual(result.replacements, []);
		}
	});
	test("keeps long non-credential runs responsive", () => {
		const input = "a-".repeat(32_000);
		assert.equal(scrubFeedback("safe", input).body, input);
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
			["**API_KEY**: bold1234secret", "**API_KEY**: [REDACTED]"],
			["**API_KEY**=bold1234secret", "**API_KEY**=[REDACTED]"],
			["*password*: italicsecret12", "*password*: [REDACTED]"],
			["`API_KEY`: codesecret1234", "`API_KEY`: [REDACTED]"],
			["__token__: undersecret123", "__token__: [REDACTED]"],
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
	test("scrubs punctuation-bearing unquoted credentials without leaking tails", () => {
		const cases = [
			["MY_SECRET=abc_def_ghi", "MY_SECRET=[REDACTED]"],
			["DB_PASSWORD=s3cr3t_p@ssw0rd", "DB_PASSWORD=[REDACTED]"],
			["GOOGLE_API_KEY=ya29.a0Af_LiveSecretTail", "GOOGLE_API_KEY=[REDACTED]"],
			["SLACK_TOKEN=abcdef*tail-secret", "SLACK_TOKEN=[REDACTED]"],
			["PASSWORD=pass~word~tail", "PASSWORD=[REDACTED]"],
			["api-key: 9f8a7b_6c5d4e3f", "api-key: [REDACTED]"],
			["TOKEN=abc+def/ghi=tail!", "TOKEN=[REDACTED]"],
			["?token=a1b2c3_d4&keep=1", "?token=[REDACTED]&keep=1"],
			["**token=abc_def**", "**token=[REDACTED]**"],
			["_token=abc_def_", "_token=[REDACTED]_"],
		] as const;
		for (const [input, expected] of cases) {
			const result = scrubFeedback("safe", input);
			assert.equal(result.body, expected);
			assert.deepEqual(result.replacements, [{ category: "credential-assignment", count: 1 }]);
			assert.deepEqual(scrubFeedback(result.title, result.body).replacements, []);
			assert.doesNotMatch(
				JSON.stringify(result),
				/abc_def_ghi|s3cr3t|LiveSecretTail|tail-secret|pass~word|9f8a7b|abc\+def\/ghi/u,
			);
		}
	});
	test("scrubs provider-redacted assignment suffixes and value-leading punctuation", () => {
		const providerCases = [
			["PASSWORD=sk-ABCDEFGHIJKLMNOPQRST.uvWxSensitiveTail", "PASSWORD=[REDACTED]"],
			["TOKEN=ghp_ABCDEFGHIJKLMNOPQRST_extraSensitiveTail", "TOKEN=[REDACTED]"],
			["API_KEY=hf_abcdefghijklmnopqrstuvwx/SensitiveTail", "API_KEY=[REDACTED]"],
		] as const;
		for (const [input, expected] of providerCases) {
			const result = scrubFeedback("safe", input);
			assert.equal(result.body, expected);
			assert.doesNotMatch(JSON.stringify(result), /SensitiveTail|extraSensitiveTail|uvWx/u);
		}
		const wrapperCases = [
			["TOKEN=_Canary42", "TOKEN=[REDACTED]"],
			["TOKEN=*Canary42", "TOKEN=[REDACTED]"],
			["TOKEN=~Canary42", "TOKEN=[REDACTED]"],
			["password: **hunter2**", "password: **[REDACTED]**"],
			["**TOKEN=abc_def**", "**TOKEN=[REDACTED]**"],
			["**Password:** hunter2", "**Password:** [REDACTED]"],
			["TOKEN=abc_def_", "TOKEN=[REDACTED]_"],
			["token: **ghp_abcdefghijklmnopqrst.secret**", "token: **[REDACTED]**"],
		] as const;
		for (const [input, expected] of wrapperCases) {
			const result = scrubFeedback("safe", input);
			assert.equal(result.body, expected);
			if (input.startsWith("token: **ghp_"))
				assert.deepEqual(result.replacements, [
					{ category: "github-token", count: 1 },
					{ category: "credential-assignment", count: 1 },
				]);
			else assert.deepEqual(result.replacements, [{ category: "credential-assignment", count: 1 }]);
			assert.deepEqual(scrubFeedback(result.title, result.body).replacements, []);
		}
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
