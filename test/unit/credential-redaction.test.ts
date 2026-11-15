import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, test } from "vitest";
import { redactUrlCredentials } from "../../packages/coding-agent/src/core/error-contract.ts";
import { configuredSecretRedactor } from "../../packages/coding-agent/src/core/storage/sqlite-facade.ts";
import { redactCredentials } from "../../packages/coding-agent/src/core/workspace/redact.ts";
import { redactCredentialShapes } from "../../packages/coding-agent/src/utils/credential-redaction.ts";
import { redactSensitiveText } from "../../packages/workflows/src/shared/workflow-failures-signals.ts";

/** A linear scan of this input takes milliseconds; a quadratic one takes minutes. */
const ADVERSARIAL_LENGTH = 200_000;
/** Generous headroom for a loaded CI runner, far below the quadratic cost. */
const LINEAR_REDACTION_BUDGET_MS = 2_000;
/** Random userinfo strings the property test tries. */
const PROPERTY_CASES = 500;
const PROPERTY_SEED = 4833;

/** A small seeded generator (mulberry32), so a failing case reproduces. */
function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

/** Upper-case letters never appear in the surrounding text, so any that survive redaction came from the password. */
const PASSWORD_ALPHABET = "QWXZ@:%@:%";

function randomPassword(random: () => number): string {
	const length = 1 + Math.floor(random() * 12);
	let password = "";
	for (let index = 0; index < length; index++) {
		password += PASSWORD_ALPHABET[Math.floor(random() * PASSWORD_ALPHABET.length)];
	}
	return password;
}

describe("URL credential redaction (#4833)", () => {
	test("removes a password or token that contains '@' (#4833)", () => {
		for (const redact of [redactCredentials, redactUrlCredentials]) {
			assert.equal(redact("https://alice:s3cr@tPass@github.com/org/repo.git"), "https://github.com/org/repo.git");
			assert.equal(
				redact("https://x-access-token:FAKE@TOKEN@@example.invalid:8443/o/r.git"),
				"https://example.invalid:8443/o/r.git",
			);
			assert.equal(redact("https://FAKE@TOKEN@example.invalid"), "https://example.invalid");
		}
		assert.equal(redactCredentials("ssh://git:pa@ss@example.invalid/r.git"), "ssh://git@example.invalid/r.git");
		assert.equal(redactCredentials("ssh://:pa@ss@example.invalid/r.git"), "ssh://example.invalid/r.git");
	});

	test("removes '@'-bearing credentials from git stderr text (#4833)", () => {
		const stderr = [
			"Cloning into 'repo'...",
			"fatal: unable to access 'https://alice:s3cr@tPass@github.com/org/repo.git/': Could not resolve host",
			"remote: see https://bob:FAKE@TOKEN@example.invalid/help and mail ops@example.invalid",
			"fatal: could not read from https://example.invalid and ops@example.invalid",
		].join("\n");
		const redacted = redactCredentials(stderr);
		assert.equal(
			redacted,
			[
				"Cloning into 'repo'...",
				"fatal: unable to access 'https://github.com/org/repo.git/': Could not resolve host",
				"remote: see https://example.invalid/help and mail ops@example.invalid",
				"fatal: could not read from https://example.invalid and ops@example.invalid",
			].join("\n"),
		);
		for (const fragment of ["s3cr", "tPass", "FAKE", "TOKEN", "alice", "bob"]) {
			assert.equal(redacted.includes(fragment), false, fragment);
		}
	});

	test("no character of a random '@', ':' or '%' password survives, and host and path stay (#4833)", () => {
		const random = seededRandom(PROPERTY_SEED);
		for (let index = 0; index < PROPERTY_CASES; index++) {
			const password = randomPassword(random);
			const url = `https://user:${password}@example.invalid:8443/org/repo.git`;
			for (const text of [url, `fatal: unable to access '${url}/': refused`]) {
				for (const redact of [redactCredentials, redactUrlCredentials]) {
					const redacted = redact(text);
					assert.equal(redacted, text.replace(`user:${password}@`, ""), `${redact.name}: ${text}`);
					assert.ok(redacted.includes("example.invalid:8443/org/repo.git"), redacted);
					assert.equal(redacted.includes("user"), false, redacted);
					for (const character of password) {
						if (character !== ":")
							assert.equal(redacted.includes(character), false, `${character} in ${redacted}`);
					}
				}
			}
		}
	});

	test("redacting adversarial '@' and scheme runs stays linear (#4833)", () => {
		const inputs = [
			`https://${"@".repeat(ADVERSARIAL_LENGTH)}`,
			`https://${"a@".repeat(ADVERSARIAL_LENGTH / 2)}host/x`,
			"a://@".repeat(ADVERSARIAL_LENGTH / 4),
			`${"a".repeat(ADVERSARIAL_LENGTH)}://u:p@h`,
			"ssh://:@".repeat(ADVERSARIAL_LENGTH / 8),
		];
		for (const redact of [redactCredentials, redactUrlCredentials]) {
			for (const input of inputs) {
				const started = performance.now();
				redact(input);
				const elapsed = performance.now() - started;
				assert.ok(elapsed < LINEAR_REDACTION_BUDGET_MS, `${redact.name} took ${Math.round(elapsed)} ms`);
			}
		}
	});
});

/** The field names the shape property test writes; none holds a digit, `Q` or `Z`. */
const FIELD_NAMES = [
	"password",
	"passwd",
	"pwd",
	"db_password",
	"token",
	"access_token",
	"github_token",
	"api_key",
	"apikey",
	"secret",
	"client_secret",
	"credential",
] as const;
/** Characters only secrets use, so any that survive redaction came from a secret. */
const SECRET_MARK = /[\dQZ]/u;
const UNQUOTED_ALPHABET = "QZ0123456789@%:/QZ";
const QUOTED_ALPHABET = `${UNQUOTED_ALPHABET}"\\'`;
const SHAPE_PROPERTY_CASES = 400;

function randomSecret(random: () => number, alphabet: string): string {
	let secret = "Q";
	const length = 3 + Math.floor(random() * 14);
	for (let index = 0; index < length; index++) secret += alphabet[Math.floor(random() * alphabet.length)];
	return secret;
}

function pick<T>(random: () => number, values: readonly T[]): T {
	return values[Math.floor(random() * values.length)]!;
}

/** A JSON, YAML or env-style document that holds each secret under a credential field name. */
function randomDocument(random: () => number): string {
	const style = pick(random, ["json", "yaml", "env"] as const);
	const fields = Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(random, FIELD_NAMES));
	if (style === "json") {
		const entries = fields.map((name) => [name, randomSecret(random, QUOTED_ALPHABET)]);
		return JSON.stringify(Object.fromEntries([["user", "name"], ...entries]), null, random() < 0.5 ? 2 : undefined);
	}
	if (style === "yaml") {
		return fields
			.map((name) =>
				random() < 0.5
					? `${name}: ${randomSecret(random, UNQUOTED_ALPHABET)}`
					: `${name}: ${JSON.stringify(randomSecret(random, QUOTED_ALPHABET))}`,
			)
			.join("\n");
	}
	return fields.map((name) => `${name.toUpperCase()}=${randomSecret(random, UNQUOTED_ALPHABET)}`).join("\n");
}

describe("credential shape redaction (#4833)", () => {
	const redactors = [redactCredentialShapes, redactSensitiveText];

	test("redacts JSON-quoted credential fields, password included (#4833)", () => {
		for (const redact of redactors) {
			for (const input of [
				'{"token":"FAKE-token-value"}',
				'{"api_key": "FAKE-api-value"}',
				'{"password":"FAKE-password"}',
				"{'passwd': 'FAKE-passwd'}",
				'{"db_password":"FAKE-db"}',
				"password=FAKE-env DB_PASSWORD=FAKE-db GITHUB_TOKEN=FAKE-gh",
				"pwd: FAKE-yaml",
				'DB_PASSWORD="FAKE spaced value" next',
				"TOKEN='FAKE spaced' next",
			]) {
				assert.equal(redact(input).includes("FAKE"), false, `${redact.name}: ${redact(input)}`);
			}
		}
	});

	test("redacts the whole quoted value past escaped quotes (#4833)", () => {
		for (const redact of redactors) {
			for (const input of [
				'{"password":"p\\"ssw0rd-tail"}',
				'{"token": "a\\\\\\"b-tail", "user": "kept"}',
				"password: 'it''s-tail'",
			]) {
				const redacted = redact(input);
				assert.equal(redacted.includes("tail"), false, `${redact.name}: ${redacted}`);
			}
			assert.ok(redact('{"token":"a\\"b", "user": "kept"}').includes('"user": "kept"'));
		}
	});

	test("removes URL user info up to the last '@' (#4833)", () => {
		for (const redact of redactors) {
			assert.equal(
				redact("fetch https://alice:s3cr@tPass@github.com/org/repo.git failed"),
				"fetch https://github.com/org/repo.git failed",
			);
		}
	});

	test("no secret character survives in random JSON, YAML and env documents (#4833)", () => {
		const random = seededRandom(PROPERTY_SEED);
		for (let index = 0; index < SHAPE_PROPERTY_CASES; index++) {
			const document = randomDocument(random);
			for (const redact of redactors) {
				const redacted = redact(document);
				assert.equal(SECRET_MARK.test(redacted), false, `${redact.name}: ${document}\n=> ${redacted}`);
			}
		}
	});

	test("redacting adversarial credential text stays linear (#4833)", () => {
		const inputs = [
			`password: "${"\\".repeat(ADVERSARIAL_LENGTH)}`,
			`"token":'${"''".repeat(ADVERSARIAL_LENGTH / 2)}`,
			"password".repeat(ADVERSARIAL_LENGTH / 8),
			`password${" ".repeat(ADVERSARIAL_LENGTH)}`,
			"_token= ".repeat(ADVERSARIAL_LENGTH / 8),
			"a".repeat(ADVERSARIAL_LENGTH),
		];
		for (const redact of redactors) {
			for (const input of inputs) {
				const started = performance.now();
				redact(input);
				const elapsed = performance.now() - started;
				assert.ok(elapsed < LINEAR_REDACTION_BUDGET_MS, `${redact.name} took ${Math.round(elapsed)} ms`);
			}
		}
	});
});

/** A value that matches no token shape, so only field, URL and configured-secret rules can remove it. */
const PLAIN_SECRET = "Zq9vR2mXw7LpT4kN";

describe("credential shape coverage", () => {
	const redactors = [redactCredentialShapes, redactSensitiveText];

	function assertGone(text: string): string {
		for (const redact of redactors) {
			const redacted = redact(text);
			assert.equal(redacted.includes("Zq9v"), false, `${redact.name}: ${JSON.stringify(redacted)}`);
		}
		return redactCredentialShapes(text);
	}

	test("camelCase credential fields are redacted", () => {
		assert.equal(assertGone(`{"authToken":"${PLAIN_SECRET}"}`), '{"authToken": [redacted]}');
		assert.equal(
			assertGone(`//registry.npmjs.org/:_authToken=${PLAIN_SECRET}`),
			"//registry.npmjs.org/:_authToken= [redacted]",
		);
		assertGone(`dbPassword: ${PLAIN_SECRET}`);
		assertGone(`apiToken=${PLAIN_SECRET}`);
		assertGone(`clientSecret: "${PLAIN_SECRET}"`);
		for (const kept of ["monkey: plain", "primaryKey: id", "tokenizer=bpe", "hotKey: ctrl"]) {
			assert.equal(redactCredentialShapes(kept), kept);
		}
	});

	test("credential fields inside an escaped JSON string are redacted", () => {
		assert.equal(
			assertGone(`{"body":"{\\"access_token\\":\\"${PLAIN_SECRET}\\",\\"user\\":\\"kept\\"}"}`),
			'{"body":"{\\"access_token\\": [redacted],\\"user\\":\\"kept\\"}"}',
		);
		assertGone(`error: {\\"password\\":\\"${PLAIN_SECRET}\\"}`);
	});

	test("an unquoted password value is redacted to the end of its line", () => {
		assert.equal(
			assertGone(`password: correct horse ${PLAIN_SECRET}\nnext: kept`),
			"password: [redacted]\nnext: kept",
		);
		assertGone(`PASSWORD=abc,${PLAIN_SECRET}`);
		assertGone(`passwd=a;${PLAIN_SECRET}`);
	});

	test("a styled authorization scheme does not keep its token", () => {
		assertGone(`Authorization: \u001b[1mBearer\u001b[0m ${PLAIN_SECRET}`);
		assertGone(`sent \u001b[1mBearer\u001b[0m ${PLAIN_SECRET}`);
		assertGone(`token=\u001b[31m${PLAIN_SECRET}\u001b[0m`);
	});

	test("PGP private key blocks are redacted", () => {
		/** Built at run time, so secret scanners do not take the fixture for a real key. */
		const label = ["PGP", "PRIVATE", "KEY", "BLOCK"].join(" ");
		assert.equal(
			assertGone(`a\n-----BEGIN ${label}-----\n\n${PLAIN_SECRET}\n-----END ${label}-----\nb`),
			"a\n[redacted]\nb",
		);
	});

	test("URL user info with a raw '/', '#' or '?' is removed", () => {
		for (const separator of ["/", "#", "?"]) {
			const text = `clone https://user:ab${separator}${PLAIN_SECRET}@example.com/repo.git failed`;
			assert.equal(redactUrlCredentials(text), "clone https://example.com/repo.git failed");
			assertGone(text);
		}
		for (const kept of [
			"https://example.com:8443/a@b",
			"https://example.com/path/user@example.org",
			"see https://example.com/x and mail ops@example.com",
		]) {
			assert.equal(redactUrlCredentials(kept), kept);
		}
	});

	test("URL user info with a raw delimiter ends at the host's own path", () => {
		assert.equal(redactUrlCredentials("https://user:ab/cd@host/path@x end"), "https://host/path@x end");
		assert.equal(redactUrlCredentials("https://user:ab/cd@host?q=a@b"), "https://host?q=a@b");
		assert.equal(redactUrlCredentials("https://user:ab/cd@host#a@b"), "https://host#a@b");
		assert.equal(redactUrlCredentials("https://:ab/cd@host/x"), "https://host/x");
		assert.equal(redactUrlCredentials("https://u:x/next://host@y"), "https://u:x/next://y");
		assert.equal(redactUrlCredentials("http://[::1]:x/a@b"), "http://[::1]:x/a@b");
	});

	test("percent-encoded nested URL user info is removed", () => {
		const text = `https://a.example/cb?next=https%3A%2F%2Fuser%3A${PLAIN_SECRET}%40b.example%2Fpath&x=1`;
		assert.equal(redactUrlCredentials(text), "https://a.example/cb?next=https%3A%2F%2Fb.example%2Fpath&x=1");
		assertGone(text);
		assert.equal(redactUrlCredentials("q=https%3A%2F%2Fb.example%2Fa%40b"), "q=https%3A%2F%2Fb.example%2Fa%40b");
		assert.equal(redactUrlCredentials("https%3a%2f%2fuser%3as%40host%2f"), "https%3a%2f%2fhost%2f");
	});

	test("credential coverage stays linear on adversarial input", () => {
		for (const input of [
			"%3A%2F%2F".repeat(ADVERSARIAL_LENGTH / 9),
			`https://u:${"/".repeat(ADVERSARIAL_LENGTH)}`,
			"https://u:x/".repeat(ADVERSARIAL_LENGTH / 12),
			"\u001b[1m".repeat(ADVERSARIAL_LENGTH / 4),
			`Bearer${"\u001b[0m".repeat(ADVERSARIAL_LENGTH / 4)}`,
			"aT".repeat(ADVERSARIAL_LENGTH / 2),
			"\\".repeat(ADVERSARIAL_LENGTH),
			`${"1".repeat(ADVERSARIAL_LENGTH)}aBearer`,
			"1 ;a".repeat(ADVERSARIAL_LENGTH / 4),
			`password:${" ".repeat(ADVERSARIAL_LENGTH)}`,
			`token:${"\u001b[0m ".repeat(ADVERSARIAL_LENGTH / 5)},`,
			`token${"\\".repeat(ADVERSARIAL_LENGTH)}`,
			"token\\\\".repeat(ADVERSARIAL_LENGTH / 7),
			`token:\\${"\\".repeat(ADVERSARIAL_LENGTH)}`,
			`-----BEGIN ${"A ".repeat(ADVERSARIAL_LENGTH / 2)}`,
			"-----BEGIN A ".repeat(ADVERSARIAL_LENGTH / 13),
			`-----BEGIN ${["PRIVATE", "KEY"].join(" ")}-----`.repeat(ADVERSARIAL_LENGTH / 27),
			"aToken=".repeat(ADVERSARIAL_LENGTH / 7),
			`Authorization: ${"\u001b[1m".repeat(ADVERSARIAL_LENGTH / 4)}`,
		]) {
			const started = performance.now();
			redactCredentialShapes(input);
			const elapsed = performance.now() - started;
			assert.ok(elapsed < LINEAR_REDACTION_BUDGET_MS, `took ${Math.round(elapsed)} ms`);
		}
	});
});

describe("configured secret redaction", () => {
	test("configured secret redaction stays linear on adversarial input", () => {
		const redact = configuredSecretRedactor(["aaaaaa", "aaaaaaab", `${"a".repeat(64)}\n${"b".repeat(64)}`]);
		for (const input of [
			"a".repeat(ADVERSARIAL_LENGTH),
			"ab".repeat(ADVERSARIAL_LENGTH / 2),
			"[redacted]a".repeat(ADVERSARIAL_LENGTH / 11),
		]) {
			const started = performance.now();
			redact(input);
			const elapsed = performance.now() - started;
			assert.ok(elapsed < LINEAR_REDACTION_BUDGET_MS, `took ${Math.round(elapsed)} ms`);
		}
	});

	test("overlapping configured secrets are redacted whole", () => {
		const redact = configuredSecretRedactor(["AAAA1111BBBB", "BBBB2222CCCC"]);
		assert.equal(redact("x AAAA1111BBBB2222CCCC y"), "x [redacted] y");
		assert.equal(redact("x AAAA1111BBBB y BBBB2222CCCC"), "x [redacted] y [redacted]");
	});

	test("encoded forms of configured secrets are redacted", () => {
		const secret = `pa"ss\\/w0rd ${PLAIN_SECRET}`;
		const redact = configuredSecretRedactor([secret]);
		for (const form of [
			JSON.stringify(secret).slice(1, -1),
			encodeURIComponent(secret),
			Buffer.from(secret).toString("base64"),
			Buffer.from(secret).toString("base64url"),
		]) {
			const redacted = redact(`before ${form} after`);
			assert.ok(redacted.startsWith("before "), redacted);
			assert.ok(redacted.endsWith(" after"), redacted);
			assert.equal(redacted.includes(form.slice(4, -4)), false, redacted);
		}
		const basic = Buffer.from(`user:${secret}`).toString("base64");
		assert.equal(redact(`Basic ${basic}`).includes(basic.slice(8, -4)), false);
	});

	test("base64 of a configured secret is redacted at any position in the encoded stream", () => {
		const secret = `w0rd ${PLAIN_SECRET}`;
		const redact = configuredSecretRedactor([secret]);
		for (const prefix of ["", "a", "ab", "abc"]) {
			const encoded = Buffer.from(`${prefix}${secret}more text`).toString("base64");
			const redacted = redact(encoded);
			assert.ok(redacted.includes("[redacted]"), `${prefix}: ${redacted}`);
			assert.ok(redacted.length < encoded.length - 10, `${prefix}: ${redacted}`);
		}
		const short = configuredSecretRedactor(["abcdef"]);
		assert.equal(short("YWJjZGVm"), "[redacted]");
		assert.equal(short("YmNk Y2Rl"), "YmNk Y2Rl");
	});

	test("short forms of a configured secret are not redacted", () => {
		const redact = configuredSecretRedactor(["ABCDEFGH\n//", "%41%42%43%44"], { minLength: 6 });
		assert.equal(redact("x %2F%2F // ABCD y"), "x %2F%2F // ABCD y");
		assert.equal(redact("x ABCDEFGH y"), "x [redacted] y");
		assert.equal(configuredSecretRedactor(["p%40ss-word"])("x p@ss-word y"), "x [redacted] y");
	});

	test("configured secrets with surrounding whitespace or several lines are redacted", () => {
		assert.equal(
			configuredSecretRedactor([`${PLAIN_SECRET}\r\n`])(`denied for ${PLAIN_SECRET}.`),
			"denied for [redacted].",
		);
		const pem = `-----BEGIN KEY-----\n  ${PLAIN_SECRET}\nAbCdEfGhIjKl\n-----END KEY-----\n`;
		assert.equal(
			configuredSecretRedactor([pem])(`bad key: ${PLAIN_SECRET} AbCdEfGhIjKl`),
			"bad key: [redacted] [redacted]",
		);
	});

	test("no configured secret survives random placement and encodings, and other text is unchanged", () => {
		const random = seededRandom(PROPERTY_SEED);
		const secretAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
		const textAlphabet = "abcdefghijklmnop .,:;=-\n";
		const draw = (alphabet: string, min: number, spread: number) =>
			Array.from({ length: min + Math.floor(random() * spread) }, () => pick(random, [...alphabet])).join("");
		for (let round = 0; round < 1_000; round++) {
			const secrets = Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
				Array.from({ length: 1 + Math.floor(random() * 2) }, () => draw(secretAlphabet, 6, 12)).join("\n"),
			);
			if (random() < 0.3) {
				const [first] = secrets;
				const tail = first!.slice(-4 - Math.floor(random() * 3));
				secrets.push(`${tail}${draw(secretAlphabet, 6, 6)}`);
			}
			const configured = secrets.map((secret) => (random() < 0.3 ? `${secret}\n` : secret));
			const pieces: string[] = [draw(textAlphabet, 0, 8)];
			let text = pieces[0]!;
			for (let index = 0; index < 1 + Math.floor(random() * 4); index++) {
				const secret = pick(random, secrets);
				const form = pick(random, [
					secret,
					secret.split("\n").join("\t"),
					encodeURIComponent(secret),
					JSON.stringify(secret).slice(1, -1),
				]);
				const between = draw(textAlphabet, 1, 8);
				text += form + between;
				pieces.push(between);
			}
			const redacted = configuredSecretRedactor(configured, { minLength: 4 })(text);
			const context = JSON.stringify({ configured, text, redacted });
			assert.equal(redacted.replace(/(?:\[redacted\]\t?)*\[redacted\]/gu, "|"), pieces.join("|"), context);
			for (const secret of secrets) {
				for (let start = 0; start + 4 <= secret.length; start++) {
					const fragment = secret.slice(start, start + 4);
					if (!fragment.includes("\n"))
						assert.equal(redacted.includes(fragment), false, `${fragment}: ${context}`);
				}
			}
		}
	});
});
