import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, test } from "vitest";
import { redactUrlCredentials } from "../../packages/coding-agent/src/core/error-contract.ts";
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
	});

	test("removes '@'-bearing credentials from git stderr text (#4833)", () => {
		const stderr = [
			"Cloning into 'repo'...",
			"fatal: unable to access 'https://alice:s3cr@tPass@github.com/org/repo.git/': Could not resolve host",
			"remote: see https://bob:FAKE@TOKEN@example.invalid/help and mail ops@example.invalid",
		].join("\n");
		const redacted = redactCredentials(stderr);
		assert.equal(
			redacted,
			[
				"Cloning into 'repo'...",
				"fatal: unable to access 'https://github.com/org/repo.git/': Could not resolve host",
				"remote: see https://example.invalid/help and mail ops@example.invalid",
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
