/**
 * The webhooks configuration file (`src/extensions/webhooks/config.ts`).
 *
 * Issue #2345: the file is the single authority for destinations. A broken
 * entry must produce a bounded diagnostic and leave the valid ones working, a
 * half-written file must never read as "no destinations", unknown keys must
 * survive a round trip, and no diagnostic may carry a URL or header value.
 *
 * Expected texts are built from the exported constants; the literal wording is
 * pinned once, in its own test, the way `mcp-tool-timeout.test.ts` pins
 * `MCP_TIMEOUT_MS_CONFIG_ERROR`.
 */

import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	createEmptyWebhooksDocument,
	parseWebhooksDocument,
	readWebhooksFile,
	WEBHOOK_EVENTS_CONFIG_ERROR,
	WEBHOOK_METHOD_CONFIG_ERROR,
	WEBHOOK_TIMEOUT_MS_CONFIG_ERROR,
	WEBHOOK_TYPE_CONFIG_ERROR,
	webhooksConfigPath,
	writeWebhooksFile,
} from "../../packages/coding-agent/src/extensions/webhooks/config.js";
import {
	MAX_WEBHOOK_DIAGNOSTICS,
	WEBHOOK_EVENT_IDS,
	WEBHOOK_TIMEOUT_MS_DEFAULT,
	WEBHOOK_TIMEOUT_MS_MAX,
	WEBHOOK_TIMEOUT_MS_MIN,
	WEBHOOKS_CONFIG_VERSION,
	WEBHOOKS_FILE_NAME,
} from "../../packages/coding-agent/src/extensions/webhooks/constants.js";
import type {
	JsonObject,
	ParsedWebhooksDocument,
	WebhooksDocumentResult,
} from "../../packages/coding-agent/src/extensions/webhooks/types.js";
import {
	fileExistsSync,
	makeTempDirectory,
	readDirectorySync,
	readTextSync,
	removeTempDirectory,
	writeTextSync,
} from "../helpers/runtime.js";

/** A value that must never appear in any diagnostic. */
const SECRET_URL = "https://hooks.slack.com/services/T000/B000/SECRETTOKEN";
const SECRET_HEADER = "Bearer sekrit-token";

function slack(over: Partial<JsonObject> = {}): JsonObject {
	return {
		name: "Work Slack",
		type: "slack",
		enabled: true,
		events: ["workflow_completed", "workflow_needs_input"],
		url: SECRET_URL,
		...over,
	};
}

function documentWith(...destinations: unknown[]): JsonObject {
	return { version: WEBHOOKS_CONFIG_VERSION, destinations: destinations as JsonObject[] };
}

function current(parsed: WebhooksDocumentResult): ParsedWebhooksDocument {
	assert.equal(parsed.kind, "current", `expected a usable document, got ${JSON.stringify(parsed)}`);
	assert.ok(parsed.kind === "current");
	return parsed;
}

function messages(parsed: WebhooksDocumentResult): string[] {
	return parsed.kind === "current" ? parsed.diagnostics.map((d) => d.message) : [parsed.message];
}

/** A regexp matching `text` literally, so an expectation built from a constant is not read as a pattern. */
function literally(text: string): RegExp {
	return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

function assertNoSecrets(texts: readonly string[]): void {
	for (const text of texts) {
		assert.ok(!text.includes(SECRET_URL), `diagnostic leaked the URL: ${text}`);
		assert.ok(!text.includes("SECRETTOKEN"), `diagnostic leaked the URL token: ${text}`);
		assert.ok(!text.includes(SECRET_HEADER), `diagnostic leaked a header value: ${text}`);
		assert.ok(!text.includes("sekrit"), `diagnostic leaked a header value: ${text}`);
	}
}

describe("webhooksConfigPath", () => {
	test("lives directly under the resolved agent directory", () => {
		assert.equal(webhooksConfigPath("/agent"), join("/agent", WEBHOOKS_FILE_NAME));
	});
});

describe("diagnostic wording", () => {
	test("the texts that embed a constant read as documented", () => {
		assert.equal(WEBHOOK_TYPE_CONFIG_ERROR, '`type` must be one of "slack", "teams", "custom"');
		assert.equal(WEBHOOK_METHOD_CONFIG_ERROR, '`method` must be one of "POST", "PUT", "PATCH"');
		assert.equal(WEBHOOK_TIMEOUT_MS_CONFIG_ERROR, "`timeoutMs` must be a whole number between 1000 and 60000");
		assert.equal(
			WEBHOOK_EVENTS_CONFIG_ERROR,
			'valid events are "agent_finished", "agent_needs_input", "agent_stopped", "workflow_completed", "workflow_needs_input", "workflow_blocked", "workflow_failed"',
		);
	});

	test("the sender's default timeout is a value a destination could set itself", () => {
		assert.ok(
			WEBHOOK_TIMEOUT_MS_DEFAULT >= WEBHOOK_TIMEOUT_MS_MIN && WEBHOOK_TIMEOUT_MS_DEFAULT <= WEBHOOK_TIMEOUT_MS_MAX,
		);
		assert.ok(Number.isInteger(WEBHOOK_TIMEOUT_MS_DEFAULT));
	});
});

describe("parseWebhooksDocument: valid input", () => {
	test("applies defaults and keeps the raw document for edits", () => {
		const document = documentWith(slack(), {
			name: "Ops Teams",
			type: "teams",
			enabled: false,
			events: [],
			url: "https://prod-00.westus.logic.azure.com/workflows/abc",
			method: "PUT",
			headers: { "X-Trace": "1" },
			body: { text: "{{message}}" },
			timeoutMs: 5_000,
		});
		const parsed = current(parseWebhooksDocument(document));
		assert.equal(parsed.document, document, "the raw document is returned by identity, not copied");
		assert.deepEqual(parsed.diagnostics, []);
		assert.equal(parsed.omitted, 0);
		assert.deepEqual(parsed.destinations[0], {
			name: "Work Slack",
			type: "slack",
			enabled: true,
			events: ["workflow_completed", "workflow_needs_input"],
			url: SECRET_URL,
			method: "POST",
			headers: {},
			index: 0,
		});
		assert.deepEqual(parsed.destinations[1], {
			name: "Ops Teams",
			type: "teams",
			enabled: false,
			events: [],
			url: "https://prod-00.westus.logic.azure.com/workflows/abc",
			method: "PUT",
			headers: { "X-Trace": "1" },
			body: { text: "{{message}}" },
			timeoutMs: 5_000,
			index: 1,
		});
	});

	test("a missing version reads as the current version; a missing destinations array reads as none", () => {
		const parsed = current(parseWebhooksDocument({}));
		assert.deepEqual(parsed.destinations, []);
		assert.deepEqual(parsed.diagnostics, []);
	});

	test("a plain http URL is allowed so a local receiver can be configured", () => {
		const parsed = current(
			parseWebhooksDocument(documentWith(slack({ type: "custom", url: "http://127.0.0.1:8099/hook" }))),
		);
		assert.equal(parsed.destinations.length, 1);
	});

	test("repeated event ids collapse to one and names are trimmed", () => {
		const parsed = current(
			parseWebhooksDocument(
				documentWith(
					slack({ name: "  Work Slack  ", events: ["agent_finished", "agent_finished", "agent_stopped"] }),
				),
			),
		);
		assert.equal(parsed.destinations[0]?.name, "Work Slack");
		assert.deepEqual(parsed.destinations[0]?.events, ["agent_finished", "agent_stopped"]);
	});
});

describe("parseWebhooksDocument: a document that is not this file's shape is malformed", () => {
	test("top level must be an object", () => {
		for (const bad of [null, [], "x", 3]) {
			const parsed = parseWebhooksDocument(bad);
			assert.equal(parsed.kind, "malformed", JSON.stringify(bad));
			assert.match(messages(parsed)[0] ?? "", /JSON object at the top level/);
		}
	});

	test("destinations must be an array when present", () => {
		const parsed = parseWebhooksDocument({ destinations: { name: "x" } });
		assert.equal(parsed.kind, "malformed");
		assert.match(messages(parsed)[0] ?? "", /`destinations` array/);
	});
});

describe("parseWebhooksDocument: a newer version is unsupported, and kept apart from malformed", () => {
	test("a numeric version this build does not know is refused and carried back", () => {
		const parsed = parseWebhooksDocument({ version: WEBHOOKS_CONFIG_VERSION + 1, destinations: [] });
		assert.equal(parsed.kind, "unsupported");
		assert.ok(parsed.kind === "unsupported");
		assert.equal(parsed.version, WEBHOOKS_CONFIG_VERSION + 1);
		assert.match(
			parsed.message,
			literally(
				`has version ${WEBHOOKS_CONFIG_VERSION + 1}; this build of Atomic reads version ${WEBHOOKS_CONFIG_VERSION}`,
			),
		);
	});

	test("a version written as a string is refused rather than coerced", () => {
		const parsed = parseWebhooksDocument({ version: String(WEBHOOKS_CONFIG_VERSION) });
		assert.equal(parsed.kind, "unsupported");
		assert.ok(parsed.kind === "unsupported");
		assert.equal(parsed.version, String(WEBHOOKS_CONFIG_VERSION));
	});
});

describe("parseWebhooksDocument: one broken destination does not take the others down", () => {
	test("each required field failure drops only that entry, names the field, and keeps the rest", () => {
		const cases: Array<[unknown, RegExp]> = [
			["not an object", /destination 1 must be an object/],
			[slack({ name: "" }), /destination 1 needs a non-empty `name`/],
			[slack({ name: undefined }), /destination 1 needs a non-empty `name`/],
			[slack({ type: "discord" }), literally(`destination "Work Slack" ${WEBHOOK_TYPE_CONFIG_ERROR}`)],
			[slack({ enabled: undefined }), /needs `enabled: true` or `enabled: false`/],
			[slack({ enabled: "yes" }), /needs `enabled: true` or `enabled: false`/],
			[slack({ events: undefined }), /needs an `events` array/],
			[
				slack({ events: ["workflow_done"] }),
				literally(`\`events\` contains "workflow_done"; ${WEBHOOK_EVENTS_CONFIG_ERROR}`),
			],
			[slack({ events: [42] }), /`events` contains number/],
			[slack({ url: "ftp://example.com/x" }), /`url` must be an http:\/\/ or https:\/\/ URL/],
			[slack({ url: "not a url" }), /`url` must be an http:\/\/ or https:\/\/ URL/],
			[slack({ url: undefined }), /`url` must be an http:\/\/ or https:\/\/ URL/],
			[slack({ method: "GET" }), literally(WEBHOOK_METHOD_CONFIG_ERROR)],
			[slack({ headers: "Authorization: x" }), /`headers` must be an object/],
			[slack({ headers: { Authorization: 42 } }), /header `Authorization` must be a string/],
			[slack({ headers: { " ": "x" } }), /`headers` contains an empty header name/],
			[slack({ timeoutMs: WEBHOOK_TIMEOUT_MS_MIN - 1 }), literally(WEBHOOK_TIMEOUT_MS_CONFIG_ERROR)],
			[slack({ timeoutMs: WEBHOOK_TIMEOUT_MS_MAX + 1 }), literally(WEBHOOK_TIMEOUT_MS_CONFIG_ERROR)],
			[slack({ timeoutMs: 1500.5 }), literally(WEBHOOK_TIMEOUT_MS_CONFIG_ERROR)],
			[slack({ timeoutMs: "5s" }), literally(WEBHOOK_TIMEOUT_MS_CONFIG_ERROR)],
		];
		for (const [broken, expected] of cases) {
			const parsed = current(parseWebhooksDocument(documentWith(broken, slack({ name: "Survivor" }))));
			assert.deepEqual(
				parsed.destinations.map((d) => [d.name, d.index]),
				[["Survivor", 1]],
				`survivor missing for ${JSON.stringify(broken)}`,
			);
			assert.equal(parsed.diagnostics.length, 1, JSON.stringify(broken));
			assert.match(parsed.diagnostics[0]!.message, expected);
			assert.equal(parsed.diagnostics[0]!.index, 0);
		}
	});

	test("several problems on one entry are all reported, each carrying the entry's name", () => {
		const parsed = current(parseWebhooksDocument(documentWith(slack({ type: "x", enabled: 1, method: "GET" }))));
		assert.equal(parsed.destinations.length, 0);
		assert.equal(parsed.diagnostics.length, 3);
		for (const diagnostic of parsed.diagnostics) {
			assert.equal(diagnostic.name, "Work Slack");
			assert.match(diagnostic.message, /^destination "Work Slack" /);
		}
	});

	test("a duplicate name keeps the first entry and rejects the later one", () => {
		const parsed = current(
			parseWebhooksDocument(
				documentWith(slack({ url: "https://a.example/1" }), slack({ url: "https://a.example/2" })),
			),
		);
		assert.deepEqual(
			parsed.destinations.map((d) => [d.url, d.index]),
			[["https://a.example/1", 0]],
		);
		assert.match(
			parsed.diagnostics[0]?.message ?? "",
			/destination "Work Slack" duplicates the name of an earlier destination/,
		);
		assert.equal(parsed.diagnostics[0]?.index, 1);
	});

	test("diagnostics never carry the URL or a header value", () => {
		const parsed = parseWebhooksDocument(
			documentWith(
				slack({ type: "nope", headers: { Authorization: SECRET_HEADER } }),
				slack({ name: "B", url: SECRET_URL, headers: { Authorization: 7 } }),
				slack({ name: "C", url: `${SECRET_URL}?x=1`, method: "DELETE" }),
			),
		);
		assertNoSecrets(messages(parsed));
	});

	test("the diagnostic list is capped and the count of what was cut is reported as a number", () => {
		const extra = 5;
		const broken = Array.from({ length: MAX_WEBHOOK_DIAGNOSTICS + extra }, (_, i) =>
			slack({ name: `d${i}`, type: "x" }),
		);
		const parsed = current(parseWebhooksDocument(documentWith(...broken)));
		assert.equal(parsed.diagnostics.length, MAX_WEBHOOK_DIAGNOSTICS);
		assert.equal(parsed.omitted, extra);
	});
});

describe("readWebhooksFile and writeWebhooksFile", () => {
	let dir: string;
	let path: string;
	beforeEach(() => {
		dir = makeTempDirectory("webhooks-config-");
		path = join(dir, "nested", WEBHOOKS_FILE_NAME);
	});
	afterEach(() => removeTempDirectory(dir));

	test("a missing file is `absent`, not an error and not an empty config", () => {
		assert.deepEqual(readWebhooksFile(path), { kind: "absent", path });
	});

	test("a file that cannot be read is `unreadable` and carries the errno, not a guess", () => {
		// A directory where the file should be is the one unreadable case every
		// platform can produce without ACL edits; EACCES follows the same path.
		const read = readWebhooksFile(dir);
		assert.deepEqual(read, { kind: "unreadable", path: dir, code: "EISDIR" });
	});

	test("a file that is not JSON is `malformed` and the message does not quote its contents", () => {
		const flatPath = join(dir, WEBHOOKS_FILE_NAME);
		writeTextSync(flatPath, `{ "destinations": [ { "url": "${SECRET_URL}" `);
		const flat = readWebhooksFile(flatPath);
		assert.equal(flat.kind, "malformed");
		assert.ok(flat.kind === "malformed");
		assert.match(flat.message, /not valid JSON \(check for a trailing comma or a partially written file\)/);
		assertNoSecrets([flat.message]);
	});

	test("a newer file is `unsupported` from disk too, so a writer can refuse to touch it", () => {
		writeWebhooksFile({ version: WEBHOOKS_CONFIG_VERSION + 1, destinations: [] }, path);
		const read = readWebhooksFile(path);
		assert.equal(read.kind, "unsupported");
		assert.ok(read.kind === "unsupported");
		assert.equal(read.path, path);
		assert.equal(read.version, WEBHOOKS_CONFIG_VERSION + 1);
	});

	test("write creates the parent directory, and read returns what was written", () => {
		const document = documentWith(slack());
		writeWebhooksFile(document, path);
		const read = readWebhooksFile(path);
		assert.equal(read.kind, "current");
		assert.ok(read.kind === "current");
		assert.deepEqual(read.document, document);
		assert.equal(read.destinations[0]?.name, "Work Slack");
		assert.ok(readTextSync(path, "utf-8").endsWith("}\n"), "file ends with a newline");
	});

	test("keys this module does not know about survive a read-modify-write round trip", () => {
		const original = {
			version: WEBHOOKS_CONFIG_VERSION,
			$comment: "hand edited",
			destinations: [{ ...slack(), note: "keep me", nested: { deep: [1, 2, 3] } }],
			extra: { anything: true },
		};
		writeWebhooksFile(original, path);
		const first = readWebhooksFile(path);
		assert.ok(first.kind === "current");
		// The document's keys are readonly, so an edit is a spread of the raw
		// object, never a mutation of what the reader handed back.
		const [entry, ...rest] = first.document.destinations as JsonObject[];
		const edited: JsonObject = { ...first.document, destinations: [{ ...entry, enabled: false }, ...rest] };
		writeWebhooksFile(edited, path);
		const second = readWebhooksFile(path);
		assert.ok(second.kind === "current");
		assert.deepEqual(second.document, {
			...original,
			destinations: [{ ...original.destinations[0], enabled: false }],
		});
		assert.equal(second.destinations[0]?.enabled, false);
	});

	test("write leaves no temp file behind and keeps the file owner-only on POSIX", () => {
		writeWebhooksFile(createEmptyWebhooksDocument(), path);
		writeWebhooksFile(documentWith(slack()), path);
		const siblings = readDirectorySync(join(dir, "nested"));
		assert.deepEqual(siblings, [WEBHOOKS_FILE_NAME], "temp files must be renamed away");
		assert.ok(fileExistsSync(path));
		if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
	});

	test("the empty document is version-stamped and round-trips as no destinations", () => {
		writeWebhooksFile(createEmptyWebhooksDocument(), path);
		const read = readWebhooksFile(path);
		assert.ok(read.kind === "current");
		assert.deepEqual(read.document, { version: WEBHOOKS_CONFIG_VERSION, destinations: [] });
		assert.deepEqual(read.destinations, []);
	});
});

describe("event id list", () => {
	test("covers the seven product events the issue names", () => {
		assert.deepEqual(
			[...WEBHOOK_EVENT_IDS],
			[
				"agent_finished",
				"agent_needs_input",
				"agent_stopped",
				"workflow_completed",
				"workflow_needs_input",
				"workflow_blocked",
				"workflow_failed",
			],
		);
	});
});
