import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, test } from "vitest";
import { generatePKCE } from "../../packages/ai/src/auth/oauth/pkce.ts";
import { redactUrlCredentials } from "../../packages/coding-agent/src/core/error-contract.ts";
import { configuredSecretRedactor } from "../../packages/coding-agent/src/core/storage/sqlite-facade.ts";
import { redactCredentials } from "../../packages/coding-agent/src/core/workspace/redact.ts";
import { redactCredentialShapes } from "../../packages/coding-agent/src/utils/credential-redaction.ts";
import { bunExecutable, spawnSyncCollect } from "../helpers/runtime.js";

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
	const redactors = [redactCredentialShapes];

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
	const redactors = [redactCredentialShapes];

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
		for (const kept of ["monkey: plain", "tokenizer=bpe", "keyboard: us", "tokens: 12"]) {
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
		assert.equal(redactUrlCredentials("https://user:!!/cd@host/x"), "https://host/x");
		assert.equal(redactUrlCredentials("https://user:12ab/cd@host/x"), "https://host/x");
		assert.equal(redactUrlCredentials("https://example.com:8090/a@b"), "https://example.com:8090/a@b");
		assert.equal(redactUrlCredentials("https://user:ab/cd@ef@host/x"), "https://host/x");
		assert.equal(redactUrlCredentials("x=https%3A%2F%2Fu%3Ap%40q%40host%2Fy"), "x=https%3A%2F%2Fhost%2Fy");
		assert.equal(redactUrlCredentials("x=https%3A%2F%2Fu%3Ap%40host y%40z"), "x=https%3A%2F%2Fhost y%40z");
		assert.equal(redactUrlCredentials("x=https%3A%2F%2Fu&p%40host"), "x=https%3A%2F%2Fu&p%40host");
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
			"cookie:".repeat(ADVERSARIAL_LENGTH / 7),
			`Cookie: ${"a=;".repeat(ADVERSARIAL_LENGTH / 3)}`,
			"Set-Cookie: x\n".repeat(ADVERSARIAL_LENGTH / 14),
			`Authorization: ${"\u001b[1m".repeat(ADVERSARIAL_LENGTH / 4)}`,
		]) {
			const started = performance.now();
			redactCredentialShapes(input);
			const elapsed = performance.now() - started;
			assert.ok(elapsed < LINEAR_REDACTION_BUDGET_MS, `took ${Math.round(elapsed)} ms`);
		}
	});
});

describe("credential field variants", () => {
	function assertGone(text: string): string {
		const redacted = redactCredentialShapes(text);
		assert.equal(redacted.includes("Zq9v"), false, JSON.stringify(redacted));
		return redacted;
	}

	test("camelCase key, secret and token suffixes are redacted", () => {
		for (const name of [
			"openaiApiKey",
			"secretAccessKey",
			"privateKey",
			"awsSecret",
			"githubToken",
			"dbCredentials",
		]) {
			assertGone(`${name}: ${PLAIN_SECRET}`);
			assertGone(`${name}=${PLAIN_SECRET}`);
			assertGone(`{"${name}":"${PLAIN_SECRET}"}`);
		}
		assert.equal(
			assertGone(`dbPassword: correct horse ${PLAIN_SECRET}\nnext: kept`),
			"dbPassword: [redacted]\nnext: kept",
		);
	});

	test("ordinary key fields are left alone while credential key names are redacted", () => {
		for (const name of ["primaryKey", "sortKey", "cacheKey", "foreignKey", "idempotencyKey", "partitionKey"]) {
			for (const text of [`${name}: id`, `${name}=id`, `{"${name}":"id"}`])
				assert.equal(redactCredentialShapes(text), text);
		}
		for (const name of [
			"openaiApiKey",
			"awsAccessKey",
			"awsSecretKey",
			"sshPrivateKey",
			"jwtAuthKey",
			"jwtSigningKey",
			"dataEncryptionKey",
			"oauthClientKey",
			"kmsMasterKey",
			"productLicenseKey",
			"key",
			"apikey",
		]) {
			assertGone(`${name}: ${PLAIN_SECRET}`);
			assertGone(`{"${name}":"${PLAIN_SECRET}"}`);
		}
	});

	test("cookie values are redacted and cookie names and attributes stay", () => {
		assert.equal(
			redactCredentialShapes(`Cookie: session=${PLAIN_SECRET}; theme=dark`),
			"Cookie: session=[redacted]; theme=[redacted]",
		);
		assert.equal(
			redactCredentialShapes(`set-cookie: sid=${PLAIN_SECRET}; Path=/; HttpOnly; Secure\nnext: kept`),
			"set-cookie: sid=[redacted]; Path=/; HttpOnly; Secure\nnext: kept",
		);
		assert.equal(
			redactCredentialShapes(`\u001b[1mSET-COOKIE\u001b[0m: \u001b[32msid=${PLAIN_SECRET}\u001b[0m; Max-Age=60`),
			"\u001b[1mSET-COOKIE\u001b[0m: \u001b[32msid=[redacted]\u001b[0m; Max-Age=60",
		);
		assert.equal(redactCredentialShapes("cookies: 3 eaten"), "cookies: 3 eaten");
		assert.equal(
			redactCredentialShapes("Cookie: flag; x= v  ; y=; z=w"),
			"Cookie: flag; x=[redacted]  ; y=; z=[redacted]",
		);
		assert.equal(redactCredentialShapes("Cookie:a=b"), "Cookie:a=[redacted]");
	});

	test("an escaped quote inside an escaped JSON value does not end it", () => {
		assert.equal(
			assertGone(`{"body":"{\\"password\\":\\"ab\\\\\\"${PLAIN_SECRET}\\",\\"user\\":\\"kept\\"}"}`),
			`{"body":"{\\"password\\": [redacted],\\"user\\":\\"kept\\"}"}`,
		);
	});

	test("terminal styling around a field name does not hide its value", () => {
		assertGone(
			`\u001b[1;39m{\n  \u001b[0m\u001b[34;1m"token"\u001b[0m\u001b[1;39m:\u001b[0m\u001b[0;32m"${PLAIN_SECRET}"\u001b[0m`,
		);
		assert.equal(
			assertGone(`\u001b[34mpassword\u001b[0m: ${PLAIN_SECRET}`),
			"\u001b[34mpassword\u001b[0m: [redacted]",
		);
		assertGone(`Authorization: Bearer abcd\u001b[0m${PLAIN_SECRET}`);
	});

	test("a YAML block scalar under a credential field is redacted", () => {
		assert.equal(
			assertGone(`password: |\n  ${PLAIN_SECRET}\n  second line\nnext: kept`),
			"password: |\n  [redacted]\nnext: kept",
		);
		assertGone(`token: >-\n    ${PLAIN_SECRET}\n`);
	});

	test("URL user info that looks like a port or a path is removed when a host follows", () => {
		assert.equal(redactUrlCredentials("https://user:1234/5678@example.com/x"), "https://example.com/x");
		assert.equal(redactUrlCredentials(`https://ab/${PLAIN_SECRET}@example.com/x`), "https://example.com/x");
		for (const kept of ["http://localhost:8080/foo@bar", "https://registry:8080/@scope/pkg", "a://u/p@h x"]) {
			assert.equal(redactUrlCredentials(kept), kept);
		}
	});

	test("an encoded '/' in encoded user info and double-encoded URLs are removed", () => {
		assert.equal(
			redactUrlCredentials(`?next=https%3A%2F%2Fuser%3Aab%2F${PLAIN_SECRET}%40b.example%2Fp`),
			"?next=https%3A%2F%2Fb.example%2Fp",
		);
		assert.equal(
			redactUrlCredentials(`?next=https%253A%252F%252Fuser%253A${PLAIN_SECRET}%2540b.example%252Fp`),
			"?next=https%253A%252F%252Fb.example%252Fp",
		);
	});
});

describe("configured secret redaction", () => {
	test("short lines of a multi-line configured secret do not redact ordinary text", () => {
		const redact = configuredSecretRedactor([`${PLAIN_SECRET}\n}\n`]);
		assert.equal(redact('{"ok":{"a":1}} and } braces'), '{"ok":{"a":1}} and } braces');
		assert.equal(redact(`x ${PLAIN_SECRET} y`), "x [redacted] y");
		assert.equal(configuredSecretRedactor(["ab\ncd"])("abacus cdrom"), "abacus cdrom");
	});

	test("base64 of a short configured secret is redacted at every alignment", () => {
		for (const secret of ["Qx7#pZ", "Qx7#pZw", "Qx7#pZwK"]) {
			const redact = configuredSecretRedactor([secret]);
			for (const prefix of ["", "u", "u:", "us:"]) {
				const encoded = Buffer.from(`${prefix}${secret}`).toString("base64");
				const redacted = redact(`Basic ${encoded}`);
				assert.ok(redacted.includes("[redacted]"), `${secret} ${prefix}: ${redacted}`);
			}
		}
	});

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

const OTHER_SECRET = "Yh3kW8pQz5RtV1mB";
const MEBIBYTE = 1_048_576;

describe("credential redaction in more contexts", () => {
	function assertGone(text: string, ...secrets: string[]): string {
		const redacted = redactCredentialShapes(text);
		for (const secret of [PLAIN_SECRET, ...secrets]) {
			assert.equal(redacted.includes(secret), false, `${JSON.stringify(text)} => ${JSON.stringify(redacted)}`);
		}
		return redacted;
	}

	function assertKept(text: string): void {
		assert.equal(redactCredentialShapes(text), text);
	}

	test("redacting a megabyte of cookie headers stays linear", () => {
		for (const input of [
			`Cookie: ${"a;".repeat(MEBIBYTE / 2)}`,
			`Cookie: ${";".repeat(MEBIBYTE)}=x`,
			`Set-Cookie: a=b${", c".repeat(MEBIBYTE / 3)}`,
			`set-cookie: ${"a=b, ".repeat(MEBIBYTE / 6)}`,
			"\ncookie: x;".repeat(MEBIBYTE / 11),
			`'cookie: ${"x; ".repeat(MEBIBYTE / 3)}`,
		]) {
			for (const redact of [redactCredentialShapes]) {
				const started = performance.now();
				redact(input);
				const elapsed = performance.now() - started;
				assert.ok(elapsed < LINEAR_REDACTION_BUDGET_MS, `${redact.name} took ${Math.round(elapsed)} ms`);
			}
		}
	});

	test("cookies written as JSON or a dictionary are redacted", () => {
		assert.equal(assertGone(`{"cookie":"sid=${PLAIN_SECRET}"}`), '{"cookie":"sid=[redacted]"}');
		assert.equal(assertGone(`{'Cookie': 'sid=${PLAIN_SECRET}; a=b'}`), "{'Cookie': 'sid=[redacted]; a=[redacted]'}");
		assertGone(`curl -H 'Cookie: sid=${PLAIN_SECRET}' https://x`);
		assertGone(`> Cookie: sid=${PLAIN_SECRET}`);
	});

	test("every value of joined Set-Cookie headers is redacted", () => {
		assert.equal(
			assertGone(`set-cookie: a=${PLAIN_SECRET}; Path=/; HttpOnly, b=${OTHER_SECRET}; Path=/`, OTHER_SECRET),
			"set-cookie: a=[redacted]; Path=/; HttpOnly, b=[redacted]; Path=/",
		);
		assert.equal(
			assertGone(`Set-Cookie: a=${PLAIN_SECRET}; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/`),
			"Set-Cookie: a=[redacted]; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/",
		);
		assert.equal(redactCredentialShapes('Set-Cookie: a="quoted"; Path=/'), 'Set-Cookie: a="[redacted]"; Path=/');
	});

	test("cookie-like prose and code stay unchanged", () => {
		assertKept("My favourite cookie: oatmeal=great; chocolate=better");
		assertKept('const c = { cookie: "theme=dark" }');
	});

	test("acronym-prefixed credential names are redacted", () => {
		assertGone(`DBPassword=${PLAIN_SECRET}`);
		assertGone(`{"SMTPPassword":"${PLAIN_SECRET}"}`);
		assertGone(`JWTSecret: ${PLAIN_SECRET}`);
	});

	test("provider key names with secret-looking values are redacted", () => {
		assertGone(`openaiKey: ${PLAIN_SECRET}`);
		assertGone(`{"stripeKey":"${PLAIN_SECRET}"}`);
		assertKept("licenseKey: see docs");
		assertKept('{"idempotencyKey":"3f2a9c1e-77aa-4b1e-9d2f-0c1b2a3d4e5f","cacheKey":"k1"}');
	});

	test("YAML block scalars end where the indentation returns to the key", () => {
		assertGone(`password: |\n\n  ${PLAIN_SECRET}`);
		assert.equal(
			redactCredentialShapes("db:\n  password: |\n    hunter2\n  user: bob\n  port: 5432"),
			"db:\n  password: |\n    [redacted]\n  user: bob\n  port: 5432",
		);
	});

	test("user info before a dotless host with a path is removed", () => {
		assert.equal(redactUrlCredentials(`https://ab/${PLAIN_SECRET}@gitlab/x`), "https://gitlab/x");
		for (const kept of ["https://registry/npm/@scope/pkg", "http://localhost:8080/foo@bar", "a://u/p@h x"]) {
			assert.equal(redactUrlCredentials(kept), kept);
		}
	});

	test("a hyperlink around a field name does not hide its value", () => {
		assertGone(`\u001b]8;;http://x\u0007password\u001b]8;;\u0007: ${PLAIN_SECRET}`);
	});

	test("command-line and netrc credentials are redacted", () => {
		assert.equal(assertGone(`mysql -u root --password ${PLAIN_SECRET} db`), "mysql -u root --password [redacted] db");
		assert.equal(assertGone(`tool --password=${PLAIN_SECRET} -v`), "tool --password=[redacted] -v");
		assert.equal(assertGone(`mysql -uroot -p'${PLAIN_SECRET}'`), "mysql -uroot -p'[redacted]'");
		assert.equal(assertGone(`curl -u bob:${PLAIN_SECRET} https://x`), "curl -u bob:[redacted] https://x");
		assert.equal(
			assertGone(`machine api.example.com login bob password ${PLAIN_SECRET}`),
			"machine api.example.com login bob password [redacted]",
		);
		for (const kept of ["gcc -pthread x.c", "tool --no-password --verbose", "cmd --token-file /run/token"]) {
			assertKept(kept);
		}
	});

	test("a password value stops at the end of its own value", () => {
		assertKept('{"password":null,"email":"bob@example.com","id":7}');
		assertKept('{"showPassword":false,"user":"bob","mode":"dark"}');
		assert.equal(redactCredentialShapes('{"password":12,"id":7}'), '{"password": [redacted],"id":7}');
		assert.equal(
			redactCredentialShapes("PASSWORD=x123 PORT=8080 HOST=localhost"),
			"PASSWORD= [redacted] PORT=8080 HOST=localhost",
		);
		assert.equal(
			redactCredentialShapes("PASSWORD=a b DB_PASSWORD=c"),
			"PASSWORD= [redacted] DB_PASSWORD= [redacted]",
		);
		assert.equal(redactCredentialShapes("password: correct horse, battery"), "password: [redacted]");
	});

	test("ordinary identifiers named like credentials stay unchanged", () => {
		for (const text of [
			'{"Items":[1,2],"nextToken":"eyAiYSI6IDEgfQ","Count":2}',
			"function f(cancelToken: CancelToken, timeout: number) {}",
			"interface A { token: string; name: string }",
			'{"isSecret":true,"name":"x"}',
			"auth state hasToken=false user=bob",
			"key_value_store_backend_config",
			"const token = this.token",
			"token: this.token,",
		]) {
			assertKept(text);
		}
		assertGone(`token_${PLAIN_SECRET}_x`);
	});
});

describe("configured multi-line secrets", () => {
	test("generic lines of a configured key do not redact text that quotes them", () => {
		const header = ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" ");
		const footer = ["-----END RSA", "PRIVATE KEY-----"].join(" ");
		const redact = configuredSecretRedactor([`${header}\nMIIEowIBAAKCAQEA${PLAIN_SECRET}\n${footer}\n`]);
		assert.equal(
			redact(`docs: a key starts with ${header} then base64`),
			`docs: a key starts with ${header} then base64`,
		);
		assert.equal(redact(`leaked MIIEowIBAAKCAQEA${PLAIN_SECRET}`), "leaked [redacted]");
	});
});

describe("credential redaction boundaries", () => {
	const cases: readonly (readonly [string, string])[] = [
		[`nextPageToken: ${PLAIN_SECRET}`, `nextPageToken: ${PLAIN_SECRET}`],
		[`pageToken=${PLAIN_SECRET}`, `pageToken=${PLAIN_SECRET}`],
		[`myNextToken: ${PLAIN_SECRET}`, "myNextToken: [redacted]"],
		['token: "abc"', "token: [redacted]"],
		["token: string;", "token: string;"],
		["token: null)", "token: null)"],
		['"token": 12,', '"token": 12,'],
		["token: 12", "token: [redacted]"],
		['"password": -1.5,', '"password": [redacted],'],
		["password: -1.5", "password: [redacted]"],
		["password: null, really", "password: [redacted]"],
		["openaiKey: abcd123", "openaiKey: abcd123"],
		["openaiKey: abcd1234", "openaiKey: [redacted]"],
		["openaiKey: abcdefgh", "openaiKey: abcdefgh"],
		['openaiKey: "abc 1234"', 'openaiKey: "abc 1234"'],
		["openaiKey: abcd-efgh", "openaiKey: [redacted]"],
		['openaiKey="abcd1234"', "openaiKey= [redacted]"],
		["primaryKey: abcd1234", "primaryKey: abcd1234"],
		["password: |\n  a\n\n  b\nnext: x", "password: |\n  [redacted]\nnext: x"],
		["password: |\r\n  a\r\nnext: x", "password: |\n  [redacted]\r\nnext: x"],
		["password: |\n  a", "password: |\n  [redacted]"],
		["password: |\nnext: x", "password: |\nnext: x"],
		["- password: >\n    a\n  b: c", "- password: >\n    [redacted]\n  b: c"],
		["  Cookie: a=b", "  Cookie: a=[redacted]"],
		["* cookie: a=b", "* cookie: a=[redacted]"],
		["< set-cookie: a=b", "< set-cookie: a=[redacted]"],
		["x > Cookie: a=b", "x > Cookie: a=[redacted]"],
		[`${"x".repeat(50)} cookie: a=b`, `${"x".repeat(50)} cookie: a=b`],
		["`Cookie: a=b` c=d", "`Cookie: a=b` c=d"],
		["`Cookie: a=b1c2d3e4` c=d", "`Cookie: a=[redacted]` c=d"],
		["Cookie: a=1;b=2", "Cookie: a=[redacted];b=[redacted]"],
		["Cookie: a=;b= ", "Cookie: a=;b= "],
		['Cookie: a="x y"; b=2', 'Cookie: a="[redacted]"; b=[redacted]'],
		['Cookie: a="xyz', 'Cookie: a="[redacted]'],
		["Set-Cookie: a=1, b=2", "Set-Cookie: a=[redacted], b=[redacted]"],
		["Set-Cookie: a=1,b=2", "Set-Cookie: a=[redacted],b=[redacted]"],
		["Set-Cookie: a=1; Path=/, x; b=2", "Set-Cookie: a=[redacted]; Path=/, x; b=2"],
		["Cookie: flag; a=1", "Cookie: flag; a=[redacted]"],
		['--password "a b" x', '--password "[redacted]" x'],
		['--password "abc', '--password "[redacted]'],
		[`-p"${PLAIN_SECRET}"`, '-p"[redacted]"'],
		["x -pabc123", "x -p[redacted]"],
		["x -pabcdef", "x -pabcdef"],
		[`x -p'${PLAIN_SECRET}`, "x -p'[redacted]"],
		[`--user=bob:${PLAIN_SECRET}`, "--user=bob:[redacted]"],
		[`-u 'bob:${PLAIN_SECRET}'`, "-u 'bob:[redacted]'"],
		[`login bob\n  password ${PLAIN_SECRET}\n`, "login bob\n  password [redacted]\n"],
	];

	test("each credential form is redacted exactly to its value", () => {
		for (const [input, expected] of cases)
			assert.equal(redactCredentialShapes(input), expected, JSON.stringify(input));
	});
});

describe("URL user info boundaries", () => {
	test("encoded user info is removed only when its password is not a port", () => {
		const cases: readonly (readonly [string, string])[] = [
			["x=https%3A%2F%2Fuser%3A1234%2F5678%40host", "x=https%3A%2F%2Fuser%3A1234%2F5678%40host"],
			["x=https%3A%2F%2Fuser%3Aab%2Fcd%40host%2Fp", "x=https%3A%2F%2Fhost%2Fp"],
			["x=https%3A%2F%2Fuser%3Aab%3Fcd%40host", "x=https%3A%2F%2Fhost"],
			["x=https%3A%2F%2Fuser%3Aab%23cd%40host", "x=https%3A%2F%2Fhost"],
			["x=https%3A%2F%2Fu%3Aab%40h%2Fp%40q", "x=https%3A%2F%2Fh%2Fp%40q"],
			["x=https%3A%2F%2Fab%2Fcd%40host", "x=https%3A%2F%2Fab%2Fcd%40host"],
			["x=https%3A%2F%2Fuser%3A%25%2Fx%40host", "x=https%3A%2F%2Fhost"],
			["x=https%3A%2F%2Fuser%3A12%25%2Fx%40host", "x=https%3A%2F%2Fhost"],
			["x=https%3A%2F%2Fuser%3A12%2F%25x%40host", "x=https%3A%2F%2Fuser%3A12%2F%25x%40host"],
			["a=https%3A%2F%2Fu%3Ap%40h b=https%3A%2F%2Fv%3Aq%40i", "a=https%3A%2F%2Fh b=https%3A%2F%2Fi"],
			["x=%3A%2F%2Fu%3A%40h%3A%2F%2Fw", "x=%3A%2F%2Fh%3A%2F%2Fw"],
		];
		for (const [input, expected] of cases) assert.equal(redactUrlCredentials(input), expected, input);
		const encoded = "x=https%3A%2F%2Fu%3Ap%40h";
		assert.equal(redactUrlCredentials(encoded, "server-url"), encoded);
	});

	test("raw user info before a delimiter is removed only before a host", () => {
		const cases: readonly (readonly [string, string])[] = [
			["https://[::1]/a@b.c/x", "https://[::1]/a@b.c/x"],
			["https:///a@b.c/x", "https:///a@b.c/x"],
			["https://user.name/x@host.com/y", "https://user.name/x@host.com/y"],
			["https://user:12/x@ho.st/y", "https://ho.st/y"],
			["https://us.er:12/x@ho.st/y", "https://us.er:12/x@ho.st/y"],
			["https://a:b/c://d@e.f/g", "https://a:b/c://e.f/g"],
			["https://ab/cd@/x", "https://ab/cd@/x"],
			["https://ab:12/cd@host/x", "https://ab:12/cd@host/x"],
			["https://ab/cd@host", "https://ab/cd@host"],
		];
		for (const [input, expected] of cases) assert.equal(redactUrlCredentials(input), expected, input);
	});
});

describe("configured secret encodings", () => {
	test("standard and URL-safe base64 of a configured secret are redacted at every alignment", () => {
		const secret = "~~~???>>>~~~";
		const redact = configuredSecretRedactor([secret]);
		for (const prefix of ["", "a", "ab"]) {
			const bytes = Buffer.from(`${prefix}${secret}`);
			for (const encoding of ["base64", "base64url"] as const) {
				const encoded = bytes.toString(encoding);
				assert.ok(/[+/_-]/u.test(encoded), encoded);
				assert.ok(redact(encoded).includes("[redacted]"), `${encoding} ${prefix}: ${redact(encoded)}`);
			}
		}
	});

	test("a configured secret shorter than the minimum is not redacted", () => {
		assert.equal(configuredSecretRedactor(["abc"], { minLength: 6 })("abc abcabc"), "abc abcabc");
		assert.equal(configuredSecretRedactor(["  abcdef  "], { minLength: 6 })("x abcdef"), "x [redacted]");
	});
});

describe("cookie headers inside a line", () => {
	test("cookie headers after a header context are redacted", () => {
		const cases: readonly (readonly [string, string])[] = [
			[`headers: Cookie: sid=${PLAIN_SECRET}`, "headers: Cookie: sid=[redacted]"],
			[`[info] request Cookie: sid=${PLAIN_SECRET}; a=b`, "[info] request Cookie: sid=[redacted]; a=[redacted]"],
			[`verbose > cookie: sid=${PLAIN_SECRET}`, "verbose > cookie: sid=[redacted]"],
			[`curl -H Cookie:sid=${PLAIN_SECRET} https://x`, "curl -H Cookie:sid=[redacted] https://x"],
			[`curl -H 'Cookie: sid=${PLAIN_SECRET}' https://x`, "curl -H 'Cookie: sid=[redacted]' https://x"],
			[`curl --cookie sid=${PLAIN_SECRET} https://x`, "curl --cookie sid=[redacted] https://x"],
			[
				`curl --cookie "sid=${PLAIN_SECRET}; a=b" https://x`,
				'curl --cookie "sid=[redacted]; a=[redacted]" https://x',
			],
			["curl --cookie cookies.txt https://x", "curl --cookie cookies.txt https://x"],
			[`{"h":"Cookie: sid=${PLAIN_SECRET}"}`, '{"h":"Cookie: sid=[redacted]"}'],
			[`{"h":"x=1, cookie: sid=${PLAIN_SECRET}"}`, '{"h":"x=1, cookie: sid=[redacted]"}'],
			['{"h":"x=1, cookie: theme=dark"}', '{"h":"x=1, cookie: theme=dark"}'],
			[`{\\"h\\":\\"Cookie: sid=${PLAIN_SECRET}\\"}`, '{\\"h\\":\\"Cookie: sid=[redacted]\\"}'],
			[`{cookie: sid=${PLAIN_SECRET}}`, "{cookie: sid=[redacted]}"],
			[`resp set-cookie: sid=${PLAIN_SECRET}; Path=/`, "resp set-cookie: sid=[redacted]; Path=/"],
			[
				"My favourite cookie: oatmeal=great; chocolate=better",
				"My favourite cookie: oatmeal=great; chocolate=better",
			],
			['const c = { cookie: "theme=dark" }', 'const c = { cookie: "theme=dark" }'],
			['const c = { a: 1, cookie: "theme=dark" }', 'const c = { a: 1, cookie: "theme=dark" }'],
		];
		for (const [input, expected] of cases) assert.equal(redactCredentialShapes(input), expected, input);
	});
});

describe("connection strings", () => {
	test("a connection-string password ends at its semicolon", () => {
		const cases: readonly (readonly [string, string])[] = [
			[`Server=db;User Id=sa;Password=${PLAIN_SECRET};`, "Server=db;User Id=sa;Password= [redacted];"],
			[`Server=db;Password=${PLAIN_SECRET};Database=app`, "Server=db;Password= [redacted];Database=app"],
			[`Password=${PLAIN_SECRET}; Trusted_Connection=no`, "Password= [redacted]; Trusted_Connection=no"],
			[`Pwd=${PLAIN_SECRET};Initial Catalog=app`, "Pwd= [redacted];Initial Catalog=app"],
			[`passwd=a;${PLAIN_SECRET}`, "passwd= [redacted]"],
		];
		for (const [input, expected] of cases) assert.equal(redactCredentialShapes(input), expected, input);
	});
});

describe("credential value edges", () => {
	test("each edge of a credential value is redacted exactly", () => {
		const cases: readonly (readonly [string, string])[] = [
			["{ token: null }", "{ token: null }"],
			['{"token": 12ab}', '{"token": [redacted]}'],
			['{"token": a12}', '{"token": [redacted]}'],
			['{"token": 1.25}', '{"token": 1.25}'],
			["password: abc  \nx", "password: [redacted]  \nx"],
			[`openaiKey: "ab'c1234"`, "openaiKey: [redacted]"],
			["note password: |\n  secret\n more", "note password: |\n  [redacted]"],
			["password: |\n  password: |\n    x", "password: |\n  [redacted]"],
			["XnextToken: Zq9vR2mXw7LpT4kN", "XnextToken: [redacted]"],
			[`${"a".repeat(70)}nextToken: Zq9vR2mXw7LpT4kN`, `${"a".repeat(70)}nextToken: [redacted]`],
			[`${"A".repeat(70)}nextToken: Zq9vR2mXw7LpT4kN`, `${"A".repeat(70)}nextToken: [redacted]`],
			['Set-Cookie: a=1; Path="/x"', 'Set-Cookie: a=[redacted]; Path="/x"'],
			['Set-Cookie: a="1"; b="2", c="3"', 'Set-Cookie: a="[redacted]"; b="2", c="[redacted]"'],
			['Cookie: a="x;y"; b=2', 'Cookie: a="[redacted]"; b=[redacted]'],
			["Set-Cookie: a=1,  b=2", "Set-Cookie: a=[redacted],  b=[redacted]"],
			["Set-Cookie: a=1, =2", "Set-Cookie: a=[redacted], =2"],
			["Cookie: a=\tb", "Cookie: a=[redacted]"],
			['{"cookie": 5}', '{"cookie": 5}'],
			['{"cookie": sid=x}', '{"cookie": sid=x}'],
			["{'cookie': 'sid=x'}", "{'cookie': 'sid=[redacted]'}"],
			["\"cookie: 'sid=x'\"", "\"cookie: 'sid=x'\""],
			['cookie: "sid=x"', 'cookie: "sid=x"'],
			['Cookie: "sid=x"', 'Cookie: "sid=[redacted]"'],
			["\tcookie: a=b", "\tcookie: a=[redacted]"],
			["\n  cookie: a=b", "\n  cookie: a=[redacted]"],
			["x\ncookie: a=b", "x\ncookie: a=[redacted]"],
			[`${"y".repeat(45)}\ncookie: a=b`, `${"y".repeat(45)}\ncookie: a=[redacted]`],
			[`${"y".repeat(45)} cookie: a=b`, `${"y".repeat(45)} cookie: a=b`],
			["x <cookie: a=b", "x <cookie: a=[redacted]"],
			["x*cookie: a=b", "x*cookie: a=b"],
			["x -H cookie: a=b", "x -H cookie: a=[redacted]"],
			["header: cookie: a=b", "header: cookie: a=[redacted]"],
			["a=1,cookie: b=2", "a=1,cookie: b=2"],
			["`cookie: a=b`", "`cookie: a=b`"],
			["'Cookie: a=b\\\\' x", "'Cookie: a=[redacted]\\\\' x"],
			["--cookie='a=1; b=2' x", "--cookie='a=[redacted]; b=[redacted]' x"],
			['--cookie "a=1', '--cookie "a=[redacted]'],
			["--cookie=a=1", "--cookie=a=[redacted]"],
			['--token="" x', "--token= [redacted] x"],
			["--token 'ab cd' x", "--token '[redacted]' x"],
			["--password\tabc x", "--password\t[redacted] x"],
			["-p'' x", "-p'' x"],
			["-pab1 x", "-pab1 x"],
			["-pabcde1 x", "-p[redacted] x"],
			["-p1abcde x", "-p[redacted] x"],
			["-u=bob:pw x", "-u=bob:[redacted] x"],
			["login a\tpassword\tb", "login a\tpassword\t[redacted]"],
		];
		for (const [input, expected] of cases)
			assert.equal(redactCredentialShapes(input), expected, JSON.stringify(input));
	});
});

describe("credential redaction, fourth pass", () => {
	const S = PLAIN_SECRET;

	test("a megabyte of repeated cookie headers and block headers stays linear", () => {
		const repeat = (unit: string) => unit.repeat(Math.ceil(MEBIBYTE / unit.length)).slice(0, MEBIBYTE);
		const staircase = (header: string) => {
			let text = "";
			for (let depth = 0; text.length < MEBIBYTE; depth++) text += `${" ".repeat(depth)}${header}\n`;
			return text.slice(0, MEBIBYTE);
		};
		const inputs = [
			repeat("Cookie: a=b "),
			repeat("Set-Cookie: a=b, "),
			repeat('"cookie":"a=b '),
			repeat("> cookie: a "),
			repeat("--cookie a=b "),
			repeat("-b a=b "),
			`Set-Cookie: ${repeat("a=b,")}`,
			`Cookie: ${repeat('a="')}`,
			repeat("'set-cookie': [ 'a=b "),
			repeat('\\"cookie\\":\\"a=b '),
			repeat("[x] cookie: a=b "),
			repeat('cookie="a=b '),
			staircase("password: |"),
			staircase("- token: |"),
			`password: |\n${"\n".repeat(MEBIBYTE)}`,
			repeat("password: |\n\n"),
			repeat("login a password b "),
			repeat("PGPASSWORD=a "),
			repeat(" -p8080:80"),
			repeat("-u 1:2 "),
		];
		for (const input of inputs) {
			for (const redact of [redactCredentialShapes]) {
				const started = performance.now();
				redact(input);
				const elapsed = performance.now() - started;
				assert.ok(
					elapsed < LINEAR_REDACTION_BUDGET_MS,
					`${redact.name} took ${Math.round(elapsed)} ms on ${JSON.stringify(input.slice(0, 30))}`,
				);
			}
		}
	});

	test("cookies in arrays, escaped JSON, logs and other notations are redacted", () => {
		const cases: readonly (readonly [string, string])[] = [
			[
				`headers: { 'set-cookie': [ 'sid=${S}; Path=/; HttpOnly' ] }`,
				"headers: { 'set-cookie': [ 'sid=[redacted]; Path=/; HttpOnly' ] }",
			],
			[`{"set-cookie":["sid=${S}; Path=/","b=${S}"]}`, '{"set-cookie":["sid=[redacted]; Path=/","b=[redacted]"]}'],
			[`{"cookie":["sid=${S}"]}`, '{"cookie":["sid=[redacted]"]}'],
			[`{"req":"{\\"cookie\\":\\"sid=${S}\\"}"}`, '{"req":"{\\"cookie\\":\\"sid=[redacted]\\"}"}'],
			[`[debug] cookie: sid=${S}`, "[debug] cookie: sid=[redacted]"],
			[`level=debug cookie="sid=${S}"`, 'level=debug cookie="sid=[redacted]"'],
			[`'Cookie' => 'sid=${S}'`, "'Cookie' => 'sid=[redacted]'"],
			[`curl -b 'sid=${S}' https://x`, "curl -b 'sid=[redacted]' https://x"],
			[`curl -b sid=${S} https://x`, "curl -b sid=[redacted] https://x"],
			["curl -b cookies.txt https://x", "curl -b cookies.txt https://x"],
			["cookie=abc", "cookie=abc"],
		];
		for (const [input, expected] of cases) assert.equal(redactCredentialShapes(input), expected, input);
	});

	test("upper-case password env names and strong credential suffixes are redacted", () => {
		const cases: readonly (readonly [string, string])[] = [
			[`PGPASSWORD=${S} psql -h db`, "PGPASSWORD= [redacted]"],
			[`MYSQLPASSWORD=${S}`, "MYSQLPASSWORD= [redacted]"],
			[`MYSQL_PWD=${S}`, "MYSQL_PWD= [redacted]"],
			[`nextAuthSecret: ${S}`, "nextAuthSecret: [redacted]"],
			[`{"pageAccessToken":"${S}"}`, '{"pageAccessToken": [redacted]}'],
			[`getAccessToken=${S}`, "getAccessToken= [redacted]"],
			[`showRefreshToken: ${S}`, "showRefreshToken: [redacted]"],
			[`isClientSecret: ${S}`, "isClientSecret: [redacted]"],
			[`useApiKey: ${S}`, "useApiKey: [redacted]"],
			[`forgotPassword: ${S}`, "forgotPassword: [redacted]"],
			["getAccessToken: null", "getAccessToken: null"],
			["nextPageToken: abc123", "nextPageToken: abc123"],
		];
		for (const [input, expected] of cases) assert.equal(redactCredentialShapes(input), expected, input);
	});

	test("ports, paths, ids, type annotations and prose stay unchanged", () => {
		for (const text of [
			"docker run -p8080:80 nginx",
			"docker run -p127.0.0.1:8080:80/tcp nginx",
			"mkdir -p/tmp/a1",
			"docker run -u 1000:1000 img",
			"function f(token: AccessToken, timeout: number): void {}",
			"I like sweets, cookie: chocolate=yes",
			"The Set-Cookie header (e.g. Set-Cookie: lang=en-US) sets a cookie.",
			"note: login bob password reset failed in the middle of a line",
			'{"s3Key":"uploads/2024/11/report-final.pdf"}',
			'{"objectKey":"img/2024/a.png"}',
		]) {
			assert.equal(redactCredentialShapes(text), text, text);
		}
		assert.equal(redactCredentialShapes(`mysql -p'${S}' -u bob:${S}`), "mysql -p'[redacted]' -u bob:[redacted]");
		assert.equal(redactCredentialShapes(`docker login -pab1cd2ef`), "docker login -p[redacted]");
		assert.equal(
			redactCredentialShapes(`machine x login bob password ${S}`),
			"machine x login bob password [redacted]",
		);
		assert.equal(redactCredentialShapes(`  login bob password ${S}`), "  login bob password [redacted]");
		assert.equal(redactCredentialShapes(`{"stripeKey":"sk9_${S}"}`), '{"stripeKey": [redacted]}');
	});
});

describe("capitalised credential values", () => {
	test("a capitalised word value is redacted unless type syntax shows it is a type", () => {
		const cases: readonly (readonly [string, string])[] = [
			["token: CorrectHorse", "token: [redacted]"],
			["token: AbcDef", "token: [redacted]"],
			["token: AbcDef, x", "token: [redacted], x"],
			["secret: MySecretValue", "secret: [redacted]"],
			["token: Abc", "token: [redacted]"],
			["password: Hunter)", "password: [redacted]"],
			["password: Hunter, x", "password: [redacted]"],
			["token=AbcDef&x=1", "token= [redacted]&x=1"],
			["a: string, token: AbcDef, b: number", "a: string, token: [redacted], b: number"],
			["f(a: string) token: AbcDef, b: number", "f(a: string) token: [redacted], b: number"],
			["x, a: string; f(token: AbcDef)", "x, a: string; f(token: [redacted]"],
			[`(${"x".repeat(130)} a: string, token: AbcDef`, `(${"x".repeat(130)} a: string, token: [redacted]`],
			["f(a: string,\ntoken: AbcDef", "f(a: string,\ntoken: [redacted]"],
			["client_secret=Zq9vR2mXw7LpT4kN&grant_type=x", "client_secret= [redacted]&grant_type=x"],
		];
		for (const [input, expected] of cases) {
			assert.equal(redactCredentialShapes(input), expected, input);
		}
	});

	test("type annotations stay readable", () => {
		for (const text of [
			"apiKey: string | undefined",
			"token: string;",
			"function f(secret: SecretRef, timeout: number) {}",
			"function f(token: AccessToken, timeout: number): void {}",
			"def f(secret_key: SecretStr, user: str): ...",
			"token: Optional[str] = None",
			"token: Record<string, string>",
			"token: Promise<Token>",
			"type A = { secret: SecretRef | null }",
			"let token: AuthToken & Disposable;",
			"  readonly token: TokenSet[];",
			"token?: AuthToken;",
			"export type F = { token: TokenFactory => void };",
			"token: Map<string, AuthToken>",
			"token: Optional[List[str]]",
			"password: str",
			"password: Optional[str]",
		]) {
			assert.equal(redactCredentialShapes(text), text, text);
		}
		assert.equal(redactCredentialShapes("password: Password)"), "password: [redacted]");
		assert.equal(
			redactCredentialShapes("connect(host: string, password: Password)"),
			"connect(host: string, password: [redacted])",
		);
	});
});

describe("type annotations need a code context", () => {
	test("capitalised values and generics outside code are redacted", () => {
		const cases: readonly (readonly [string, string])[] = [
			["token: CorrectHorse | tee out.log", "token: [redacted] | tee out.log"],
			["api_key: CorrectHorse & echo", "api_key: [redacted] & echo"],
			["token: CorrectHorse => x", "token: [redacted] => x"],
			["token: CorrectHorse[]", "token: [redacted]"],
			["login(user: Bob, token: CorrectHorse)", "login(user: Bob, token: [redacted]"],
			[`token: Optional[${PLAIN_SECRET}]`, "token: [redacted]"],
			[`token: Map<${PLAIN_SECRET}>`, "token: [redacted]"],
			[`token: Map<string, ${"A".repeat(41)}>`, `token: [redacted], ${"A".repeat(41)}>`],
			["token: Optional[Token9]", "token: [redacted]"],
			["token: Optional[", "token: [redacted]"],
			["token: Optional[str", "token: [redacted]"],
			["token: Optional[str]x", "token: [redacted]"],
			[`token: Map<${"Abc, ".repeat(50)}Abc>`, `token: [redacted], ${"Abc, ".repeat(49)}Abc>`],
			["token: Foo<string>", "token: [redacted]"],
			[
				`${"q".repeat(50)}const ${"p".repeat(113)} token: AuthToken`,
				`${"q".repeat(50)}const ${"p".repeat(113)} token: [redacted]`,
			],
		];
		for (const [input, expected] of cases) {
			assert.equal(redactCredentialShapes(input), expected, input);
		}
	});

	test("capitalised values in declarations and typed parameter lists stay", () => {
		for (const text of [
			"login(user: string, token: CorrectHorse)",
			"login(user: str, token: CorrectHorse)",
			"interface A { token: AuthToken }",
			"  const token: AuthToken = load();",
			"var token: AuthToken",
			"class A { private token: AuthToken }",
			"  protected token: AuthToken;",
			"  public token: AuthToken;",
			"def f(token: AuthToken): ...",
			"token: Optional[CorrectHorse]",
			`token: Map<string, ${"A".repeat(40)}>`,
			"token: Record<string, Array<Token>>",
			"token: Record<Array<Token>, string>",
		]) {
			assert.equal(redactCredentialShapes(text), text, text);
		}
	});

	test("a password inside a parameter list stops at the next comma or parenthesis", () => {
		const cases: readonly (readonly [string, string])[] = [
			[
				"connect(host: string, password: Password, timeout = 30)",
				"connect(host: string, password: [redacted], timeout = 30)",
			],
			["connect(password=hunter2, timeout=30)", "connect(password= [redacted], timeout=30)"],
			["connect(a) password: x, y", "connect(a) password: [redacted]"],
			["password: Hunter, x", "password: [redacted]"],
			["login(user: string, password: string): Session", "login(user: string, password: string): Session"],
			["login(password: Optional[str], x)", "login(password: Optional[str], x)"],
			["login(password: 'a, b', x)", "login(password: [redacted], x)"],
			["login(password:'a, b', x)", "login(password: [redacted], x)"],
			["connect(password: abc", "connect(password: [redacted]"],
		];
		for (const [input, expected] of cases) assert.equal(redactCredentialShapes(input), expected, input);
	});
});

describe("remaining leak and over-redaction cases (#5142)", () => {
	const S = PLAIN_SECRET;
	/** A numeric password, built here so no scanner reads the test as holding one. */
	const DIGITS = ["1234", "5678"].join("");

	test("secrets in less common formats are redacted (#5142)", () => {
		const cases: readonly (readonly [string, string])[] = [
			[`Cookie: sid=ab}${S}`, "Cookie: sid=[redacted]"],
			[`Cookie: sid=ab\\${S}`, "Cookie: sid=[redacted]"],
			[`curl -ubob:${S} https://x`, "curl -ubob:[redacted] https://x"],
			[`tool --password -${S}`, "tool --password [redacted]"],
			["mysql -uroot -pcorrecthorsebattery", "mysql -uroot -p[redacted]"],
			[`docker login -u bob -p ${S} ghcr.io`, "docker login -u bob -p [redacted] ghcr.io"],
			[`api_key=data.${S}`, "api_key= [redacted]"],
			[`Server=db;Password=ab;cd=${S};Database=app`, "Server=db;Password= [redacted];Database=app"],
			[`{"password":${DIGITS}}`, '{"password": [redacted]}'],
			[`machine x password ${S} login bob`, "machine x password [redacted] login bob"],
			[`default login bob password ${S}`, "default login bob password [redacted]"],
			[`password:\n    ${S}`, "password:\n    [redacted]"],
			[`Password: ${S}. Rotate it soon`, "Password: [redacted]. Rotate it soon"],
		];
		for (const [input, expected] of cases) {
			assert.equal(redactCredentialShapes(input), expected, JSON.stringify(input));
		}
	});

	test("documentation, code and prose around credential names stay unchanged (#5142)", () => {
		for (const text of [
			"Supported headers: Cookie: name=value; Set-Cookie: name=value",
			"| Set-Cookie | `Set-Cookie: id=a3fWa; Max-Age=2592000` |",
			'document.cookie = "theme=dark; path=/; max-age=31536000";',
			"login bob password reset failed",
			"login root password: hidden",
			"PASSWORD= PORT=8080",
			"if (options.password === undefined) options.password = process.env.DB_PASSWORD;",
			"Set `password:` in config.yaml; tokens expire after 1h.",
			"  DB_PASSWORD:  <set to the key 'password' in secret 'db'>  Optional: false",
			"  API_TOKEN:    <set to the key 'token' in secret 'api'>",
			"password: (not set)",
			"Password: must be 8+ characters, include a digit; see below",
			"gcc -pthread -pedantic x.c",
			"ssh -p 2222 host",
		]) {
			assert.equal(redactCredentialShapes(text), text, text);
		}
		// A cookie value that looks generated is still redacted in prose and code.
		assert.equal(
			redactCredentialShapes(`document.cookie = "sid=${S}; path=/";`),
			'document.cookie = "sid=[redacted]; path=/";',
		);
	});

	test("a value never extends past a line break (#5142)", () => {
		const code = "def login(self, password: str) -> Token:\n    token = self.client.auth(user)\n    return token";
		assert.equal(redactCredentialShapes(code), code);
		assert.equal(redactCredentialShapes("token: Bearer\nnext line"), "token: [redacted]\nnext line");
		assert.equal(redactCredentialShapes("Authorization: Bearer\nabc"), "Authorization: [redacted]\nabc");
		assert.equal(redactCredentialShapes("password=\nPORT=8080"), "password=\nPORT=8080");
		// Only a value alone on the next line, indented deeper, belongs to a name that ends its line, as in YAML.
		assert.equal(redactCredentialShapes(`token:\n${S}`), `token:\n${S}`);
		assert.equal(redactCredentialShapes(`  token:\n  ${S}`), `  token:\n  ${S}`);
		assert.equal(redactCredentialShapes(`  token:\n    ${S}`), "  token:\n    [redacted]");
	});

	test("a value megabytes long is redacted without exhausting the regular expression stack (#5142)", () => {
		const length = 8 * 1024 * 1024;
		for (const text of [
			`PASSWORD=${"a ".repeat(length / 2)}`,
			`"password":"${"a".repeat(length)}"`,
			`\\"password\\":\\"${"a".repeat(length)}`,
			`Cookie: a=${"b".repeat(length)}`,
			`${["-----BEGIN", "PRIVATE KEY-----"].join(" ")}\n${"a".repeat(length)}`,
		]) {
			const redacted = redactCredentialShapes(text);
			assert.ok(redacted.length < 1024, text.slice(0, 20));
			assert.ok(redacted.includes("[redacted]"), text.slice(0, 20));
		}
	});
	test("edges of placeholders, next-line values, prose and cookie contexts (#5142)", () => {
		const header = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
		const footer = ["-----END", "PRIVATE KEY-----"].join(" ");
		const cases: readonly (readonly [string, string])[] = [
			["password: hidden.", "password: hidden."],
			[`  token:\r\n    ${S}`, "  token:\r\n    [redacted]"],
			[`x:\n    token:\n  ${S}`, `x:\n    token:\n  ${S}`],
			["  token:\n    abc def", "  token:\n    abc def"],
			["  token:\n    abc:def", "  token:\n    abc:def"],
			["  token:\n    :abc", "  token:\n    :abc"],
			["password: must be eight characters", "password: must be eight characters"],
			["password: must red green long.", "password: must red green long."],
			["password:`abc`", "password: [redacted]"],
			['password: "Abc. Def"', "password: [redacted]"],
			['password: "must be at least eight"', "password: [redacted]"],
			["password=must be at least eight characters", "password= [redacted]"],
			["(e.g. Cookie: sid=abcdefghij)", "(e.g. Cookie: sid=abcdefghij)"],
			["Cookie: a= value", "Cookie: a= value"],
			['level=debug cookie="theme=dark"', 'level=debug cookie="theme=[redacted]"'],
			[`${footer}\n${header}\nabc`, `${footer}\n[redacted]`],
			["mysql -uroot\ngcc -pthread a.c", "mysql -uroot\ngcc -pthread a.c"],
		];
		for (const [input, expected] of cases)
			assert.equal(redactCredentialShapes(input), expected, JSON.stringify(input));
	});

	test("a line too long to read is redacted while the lines around it stay (#5142)", () => {
		const text = `x\nPASSWORD=${"a ".repeat(4 * 1024 * 1024)}\ny`;
		// Whether the regular expression stack runs out depends on the platform: either way the value is gone and the
		// lines around it stay.
		const redacted = redactCredentialShapes(text);
		assert.ok(["x\n[redacted]\ny", "x\nPASSWORD= [redacted]\ny"].includes(redacted), redacted.slice(0, 40));
	});
});

/** Budget for spawning a Bun child process to verify JSC Yarr parity on MB-scale inputs. */
const BUN_SUBPROCESS_TIMEOUT_MS = 60_000;

describe("OAuth credential shapes and linear-time scanning across Node and Bun", () => {
	test("redacts auth=Bearer, Authorization=Basic, and other assigned auth schemes without dropping the token", () => {
		const cases: readonly (readonly [string, string])[] = [
			["auth=Bearer opaqueAuthEqTok9988", "auth= [redacted] [redacted]"],
			["auth=Bearer\topaqueTabTok9988", "auth= [redacted]\t[redacted]"],
			["Authorization=Bearer opaqueAuthEqTok9988", "Authorization= [redacted] [redacted]"],
			["Authorization=Basic Y2xpZW50OnNlY3JldDEyMw==", "Authorization= [redacted] [redacted]"],
			["auth=Digest opaqueDigTok99", "auth= [redacted] [redacted]"],
			["auth=Token opaqueTok99", "auth= [redacted] [redacted]"],
			["auth=ApiKey opaqueKey99", "auth= [redacted] [redacted]"],
			["auth=OAuth opaqueOAuth99", "auth= [redacted] [redacted]"],
			['{"auth": Bearer opaqueJsonBearer99}', '{"auth": [redacted] [redacted]}'],
			["auth=Bearer opaqueTok99 PORT=8080", "auth= [redacted] [redacted] PORT=8080"],
			["auth=Bearer\nnext", "auth= [redacted]\nnext"],
			["Bearer tok%2Ftail%3D", "[redacted][redacted]"],
			["Bearer tok:secretTail", "[redacted][redacted]"],
			["Expected Bearer https://example.com/auth", "Expected [redacted]://example.com/auth"],
			["Cookie: a=}}", "Cookie: a=[redacted]}"],
			["login u password smachine h", "login u password [redacted]machine h"],
			["password:  . Aa", "password: [redacted]. Aa"],
			// Position-based alignment: never steal across lines or corrupt earlier/later fields
			["token=x mySecret99\nauth=Bearer mySecret99", "token= [redacted] mySecret99\nauth= [redacted] [redacted]"],
			['token="x":secretTail\nBearer realTok:secretTail', "token= [redacted]:secretTail\n[redacted][redacted]"],
			[
				'token="x"%2FsecretTail\nBearer realTok%2FsecretTail',
				"token= [redacted]%2FsecretTail\n[redacted][redacted]",
			],
			["auth=Bearer Bearer tok%2FsecretTail", "auth= [redacted] [redacted][redacted]"],
			// Combined --code-verifier + code_verifier: | + code_verifier= + base markers stay intact
			[
				"--code-verifier x code_verifier=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
				"--code-verifier [redacted] code_verifier= [redacted]",
			],
			[
				"code_verifier: |\n  AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\npassword=MAIN_SECRET_99\ncode_verifier=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
				"code_verifier: |\n  [redacted]\npassword= [redacted]\ncode_verifier= [redacted]",
			],
			// Long-line JSON password marker integrity (no [redacted]] corruption)
			[`${"x".repeat(4100)} {"password":"SEC99"}`, `${"x".repeat(4100)} {"password": [redacted]}`],
			[`${"x".repeat(4100)} {\\"password\\":\\"SEC99\\"}`, `${"x".repeat(4100)} {\\"password\\": [redacted]}`],
			// Regression coverage: netrc ANSI-split, doubled schemes, adjacent fields, backslash/paren passwords, ANSI reset
			[
				"machine example.com login alice pass\x1b[31mword\x1b[0m mySecretToken99",
				"machine example.com login alice pass\x1b[31mword\x1b[0m [redacted]",
			],
			["login alice pass\x1b[1mword\x1b[0m mySecretToken99", "login alice pass\x1b[1mword\x1b[0m [redacted]"],
			["auth=Bearer Bearer mySecretToken99", "auth= [redacted] [redacted]"],
			["auth=Basic Bearer mySecretToken99", "auth= [redacted] [redacted]"],
			["auth=Bearer token: mySecretToken99", "auth= [redacted] token: [redacted]"],
			['{"auth": Bearer token: mySecretToken99}', '{"auth": [redacted] token: [redacted]}'],
			["password: \\mySecret. TailSecret99", "password: [redacted]"],
			["password: \\x must be a valid password", "password: [redacted]"],
			["(password: mySecret! TailSecret99)", "(password: [redacted])"],
			["f(password: mySecret. TailSecret99, timeout=30)", "f(password: [redacted], timeout=30)"],
			["code_verifier:\n  token: mySecretToken99", "code_verifier:\n  token: [redacted]"],
			["code_verifier=token: mySecretToken99", "code_verifier=token: [redacted]"],
			["--code-verifier token: mySecretToken99", "--code-verifier token: [redacted]"],
			["\x1b[31mPASSWORD=mySecret99\x1b[0m \n", "\x1b[31mPASSWORD= [redacted]\x1b[0m \n"],
			["auth=\x1b[31mBearer\x1b[0m mySecret99", "auth=\x1b[31m [redacted]\x1b[0m [redacted]"],
			["Bearer tok\x1b[31m%2Fsecret\x1b[0m", "[redacted]\x1b[31m[redacted]\x1b[0m"],
			["rejected \x1b[31mBasic\x1b[0m Y2xpZW50OnNlY3JldA==", "rejected \x1b[31m[redacted]\x1b[0m [redacted]"],
		];
		for (const [input, expected] of cases) {
			assert.equal(redactCredentialShapes(input), expected, JSON.stringify(input));
		}
	});

	test("redacts standalone RFC 7617 Basic credentials (including all-lowercase, empty side, Unicode, unpadded, ANSI) while keeping Basic prose", () => {
		const producerPayloads = [
			Buffer.from("client:secret123").toString("base64"),
			Buffer.from("a:b").toString("base64"),
			Buffer.from("j:j").toString("base64"),
			Buffer.from("j:jjjj").toString("base64"),
			Buffer.from("j:jjjjjjj").toString("base64"),
			Buffer.from("jjjj:jjjjjjj").toString("base64"),
			Buffer.from(":secretOnly").toString("base64"),
			Buffer.from("userOnly:").toString("base64"),
			Buffer.from(":").toString("base64"),
			Buffer.from("üser:pässwörd").toString("base64"),
			Buffer.from("client:secret").toString("base64").replace(/=+$/u, ""),
		];
		for (const b64 of producerPayloads) {
			for (const sample of [
				`rejected Basic ${b64}`,
				`rejected basic\t${b64}`,
				`rejected \x1b[31mBasic\x1b[0m ${b64}`,
				`rejected \x1b]8;;https://x\x1b\\Basic\x1b]8;;\x1b\\ ${b64}`,
				`msg="rejected \\"Basic ${b64}\\""`,
				`Basic ${b64}\\nnext`,
				`{"Basic ${b64}": true}`,
				`Proxy-Authorization: Basic ${b64}`,
			]) {
				const out = redactCredentialShapes(sample);
				assert.equal(out.includes(b64), false, `${sample} => ${out}`);
			}
		}
		for (const kept of [
			"Basic auth failed",
			"Basic mode enabled",
			"Basic HTTP client",
			"Basic Settings",
			"Basic Authentication",
			"Basic Credentials",
			"Basic Examples",
			"Basic Overview",
			"Basic HTTP/1.1",
			"Basic auth-flow",
			"Basic user_id",
			'Basic realm="example"',
			"Basic (expected Bearer)",
		]) {
			assert.equal(redactCredentialShapes(kept), kept, kept);
		}
	});

	test("redacts RFC 7636 code_verifier from generatePKCE() and edge 43-128 char unreserved verifiers across formats", async () => {
		const { verifier } = await generatePKCE();
		const edgeVerifiers = [
			verifier,
			"AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE",
			`data.${"A".repeat(38)}`,
			`A${"a".repeat(42)}`,
			"x".repeat(43),
			`~${"aZ09._~-".repeat(6)}`,
			`${"aZ09._~-".repeat(16)}`,
		];
		for (const v of edgeVerifiers) {
			const samples = [
				`{"code_verifier":"${v}"}`,
				`{\\"code_verifier\\":\\"${v}\\"}`,
				`code_verifier=${v}&grant_type=authorization_code`,
				`code_verifier: ${v}`,
				`code-verifier=${v}`,
				`{"codeVerifier":"${v}"}`,
				`pkceCodeVerifier=${v}`,
				`code_verifier\x1b[0m=${v}`,
				`const line = "code_verifier=${v}"`,
				`tool --code-verifier ${v}`,
				`tool --code-verifier=${v}`,
			];
			for (const sample of samples) {
				const out = redactCredentialShapes(sample);
				assert.equal(out.includes(v), false, `${sample} => ${out}`);
			}
		}
		// Keep non-secret code/type forms and diagnostics main preserves
		for (const kept of [
			"codeVerifier: string",
			'{"code_verifier": null}',
			"codeVerifier: this.codeVerifier",
			"hasCodeVerifier: false",
			"connect ECONNREFUSED (code=ECONNREFUSED)",
			"spawn node failed: code=ENOENT",
			"OAuth failed code=invalid_grant",
			"Unsupported token_type: Bearer (expected DPoP)",
			"missing bearer.",
			"use bearer, not basic",
			"Bearer: required",
			"Bearer =foo",
		]) {
			assert.equal(redactCredentialShapes(kept), kept, kept);
		}
	});

	test("redacts long password=, password:, quoted, escaped-JSON, provider-key, cookie, and netrc lines linearly without engine limits on Node", () => {
		const cases: readonly (readonly [string, string, string])[] = [
			["pwd_env_8kb", `password=myEnvSecret9988 ${"z ".repeat(4000)}`, "myEnvSecret9988"],
			["pwd_env_1mb", `password=myEnvSecret9988 ${"z ".repeat(500_000)}`, "myEnvSecret9988"],
			["pwd_semi_40kb", `password=mySemiSecret9988${";x".repeat(20_000)}`, "mySemiSecret9988"],
			["pwd_bare_260kb", `password: myBareSecret9988 ${"z ".repeat(130_000)}`, "myBareSecret9988"],
			["quoted_esc_500kb", `"password":"${"\\a".repeat(250_000)}myQuotedSec99"`, "myQuotedSec99"],
			["esc_json_750kb", `\\"password\\":\\"${"\\\\a".repeat(250_000)}myEscSec99\\"`, "myEscSec99"],
			["provider_key_1mb", `openaiKey="${"\\a".repeat(550_000)}myProvSec99"`, "myProvSec99"],
			["cookie_bs_1mb", `Cookie: sid=${"\\x".repeat(550_000)}myCookSec99`, "myCookSec99"],
			["cookie_brace_1mb", `Cookie: sid=${"}x".repeat(550_000)}myCookSec99`, "myCookSec99"],
			["netrc_1mb", `machine h ${"login a ".repeat(150_000)}password myNetrcSec99`, "myNetrcSec99"],
		];
		for (const [label, input, needle] of cases) {
			const started = performance.now();
			const out = redactCredentialShapes(input);
			const elapsed = performance.now() - started;
			assert.equal(out.includes(needle), false, `${label} leaked ${needle}`);
			assert.ok(elapsed < LINEAR_REDACTION_BUDGET_MS, `${label} took ${Math.round(elapsed)} ms`);
		}
		for (const ansi of ["\x1b]".repeat(100_000), "\x1b[0".repeat(100_000)]) {
			const started = performance.now();
			assert.equal(redactCredentialShapes(ansi), ansi);
			const elapsed = performance.now() - started;
			assert.ok(elapsed < LINEAR_REDACTION_BUDGET_MS, `unterminated ANSI took ${Math.round(elapsed)} ms`);
		}
	});

	test(
		"redacts assigned auth schemes, standalone Basic, code_verifier, and MB-scale inputs identically under Bun without silent match-limit bypasses",
		() => {
			const script = `
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { redactCredentialShapes } from "./packages/coding-agent/src/utils/credential-redaction.ts";

const cases = [
	["auth_eq_bearer", "auth=Bearer opaqueAuthEqTok9988", "opaqueAuthEqTok9988"],
	["authz_eq_basic", "Authorization=Basic Y2xpZW50OnNlY3JldDEyMw==", "Y2xpZW50OnNlY3JldDEyMw=="],
	["standalone_basic", "rejected Basic Y2xpZW50OnNlY3JldDEyMw==", "Y2xpZW50OnNlY3JldDEyMw=="],
	["standalone_basic_lower", "rejected Basic ajpqampq", "ajpqampq"],
	["code_verifier_json", '{"code_verifier":"AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"}', "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"],
	["pwd_env_3kb_semi_sp", "password=myEnvSecret9988" + " ;".repeat(1535) + "x", "myEnvSecret9988"],
	["pwd_env_8kb", "password=myEnvSecret9988 " + "z ".repeat(4000), "myEnvSecret9988"],
	["pwd_env_1mb", "password=myEnvSecret9988 " + "z ".repeat(500_000), "myEnvSecret9988"],
	["pwd_semi_40kb", "password=mySemiSecret9988" + ";x".repeat(20_000), "mySemiSecret9988"],
	["pwd_bare_260kb", "password: myBareSecret9988 " + "z ".repeat(130_000), "myBareSecret9988"],
	["quoted_esc_500kb", '"password":"' + "\\\\a".repeat(250_000) + 'myQuotedSec99"', "myQuotedSec99"],
	["esc_json_750kb", '\\\\"password\\\\":\\\\"' + "\\\\\\\\a".repeat(250_000) + 'myEscSec99\\\\"', "myEscSec99"],
	["yaml_nextline_pwd", 'password:\\n  "' + "\\\\a".repeat(130_000) + 'myYamlPwd99"', "myYamlPwd99"],
	["yaml_nextline_tok", 'token:\\n  "' + "\\\\a".repeat(70_000) + 'myYamlTok99"', "myYamlTok99"],
	["provider_key_1mb", 'openaiKey="' + "\\\\a".repeat(550_000) + 'myProvSec99"', "myProvSec99"],
	["cookie_bs_1mb", "Cookie: sid=" + "\\\\x".repeat(550_000) + "myCookSec99", "myCookSec99"],
	["cookie_brace_1mb", "Cookie: sid=" + "}x".repeat(550_000) + "myCookSec99", "myCookSec99"],
	["cookie_array_1mb", '{"set-cookie":["sid=' + "\\\\x".repeat(550_000) + 'myCookArr99"]}', "myCookArr99"],
	["cookie_opt_b_1mb", 'curl -b "sid=' + "\\\\x".repeat(550_000) + 'myCookOptB99" https://x', "myCookOptB99"],
	["cookie_opt_long_1mb", "curl --cookie sid=" + "\\\\x".repeat(550_000) + "myCookOptL99 https://x", "myCookOptL99"],
	["netrc_4mb_single", "machine h " + "login a ".repeat(500_000) + "password myNetrc4m99", "myNetrc4m99"],
	["netrc_4mb_multi", "machine h\\n" + "login a\\n".repeat(500_000) + "password myNetrcM4m99", "myNetrcM4m99"],
	["pem_4mb_words", "-----BEGIN " + "A ".repeat(1_000_000) + "PRIVATE KEY-----\\nmyPem4m99\\n-----END PRIVATE KEY-----", "myPem4m99"],
	["cred_opt_4mb_prefix", "--" + "a-".repeat(1_000_000) + "password myCredOpt4m99", "myCredOpt4m99"],
];
for (const [label, input, needle] of cases) {
	const started = performance.now();
	const out = redactCredentialShapes(input);
	const elapsed = performance.now() - started;
	assert.equal(out.includes(needle), false, label + " leaked on Bun");
	assert.ok(elapsed < 2000, label + " took " + Math.round(elapsed) + " ms on Bun");
}
const huge = "x\\nPASSWORD=" + "a ".repeat(4 * 1024 * 1024) + "\\ny";
assert.equal(redactCredentialShapes(huge), "x\\nPASSWORD= [redacted]\\ny");
for (const ansi of ["\\x1b]".repeat(100_000), "\\x1b[0".repeat(100_000)]) {
	const started = performance.now();
	assert.equal(redactCredentialShapes(ansi), ansi);
	assert.ok(performance.now() - started < 2000);
}
for (const kept of [
	"connect ECONNREFUSED (code=ECONNREFUSED)",
	"OAuth failed code=invalid_grant",
	"Basic auth failed",
	"Basic Settings",
	"Basic Overview",
	"Unsupported token_type: Bearer (expected DPoP)",
]) {
	assert.equal(redactCredentialShapes(kept), kept, kept);
}
console.log("BUN_REDACTION_OK");
`;
			const result = spawnSyncCollect([bunExecutable(), "-e", script]);
			const stdout = result.stdout.toString();
			const stderr = result.stderr.toString();
			assert.equal(result.exitCode, 0, `Bun check failed:\nstdout=${stdout}\nstderr=${stderr}`);
			assert.ok(stdout.includes("BUN_REDACTION_OK"), stdout);
		},
		BUN_SUBPROCESS_TIMEOUT_MS,
	);
});
