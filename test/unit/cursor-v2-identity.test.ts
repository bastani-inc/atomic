import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { deriveCursorAccountScope, validateCursorHostOAuthCredential } from "../../packages/cursor/src/account-scope.js";
import {
	CURSOR_SELECTION_VERSION,
	createCursorRouteReferences,
	parseCursorSelectionRecord,
	toCursorSelectionRecord,
} from "../../packages/cursor/src/route-reference.js";
import { CursorError } from "../../packages/cursor/src/errors.js";

function jwt(payload: Record<string, string | number>, signature = "signature"): string {
	const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.${signature}`;
}

const now = 2_000_000;
function oauth(overrides: Partial<{ access: string; refresh: string; expires: number }> = {}) {
	const token = jwt({ iss: "https://authentication.cursor.sh", sub: "auth0|opaque-user", exp: 3_000 });
	return { type: "oauth" as const, access: token, refresh: token, expires: now + 60_000, ...overrides };
}

describe("Cursor account scope", () => {
	test("derives a stable non-secret domain-separated scope from exact issuer and subject", () => {
		const first = deriveCursorAccountScope(oauth(), now);
		const second = deriveCursorAccountScope(oauth({ access: oauth().access, refresh: oauth().refresh }), now);
		assert.ok(first);
		assert.equal(first, second);
		assert.match(first, /^cursor-account-v1:[A-Za-z0-9_-]{43}$/u);
		assert.doesNotMatch(first, /authentication|auth0|opaque-user/u);
	});

	test("separates host authentication validity from optional stable account identity", () => {
		const good = oauth();
		assert.throws(() => deriveCursorAccountScope({ ...good, expires: now }, now), CursorError);
		assert.throws(() => deriveCursorAccountScope({ ...good, access: "" }, now), CursorError);
		assert.throws(
			() => deriveCursorAccountScope({ ...good, refresh: jwt({ iss: "https://authentication.cursor.sh", sub: "other" }) }, now),
			CursorError,
		);
		assert.equal(deriveCursorAccountScope({ ...good, refresh: "opaque-refresh-token" }, now), deriveCursorAccountScope(good, now));
		assert.equal(deriveCursorAccountScope({ ...good, access: "opaque-access", refresh: "opaque-refresh" }, now), undefined);
		assert.equal(deriveCursorAccountScope({ ...good, access: jwt({ iss: "https://example.com", sub: "a" }) }, now), undefined);
	});

	test("malformed credentials with omitted fields raise structured errors, not raw TypeErrors", () => {
		// Omitted access/refresh arrive at runtime as undefined despite the declared string type.
		for (const malformed of [
			{ type: "oauth", refresh: "r", expires: now + 60_000 },
			{ type: "oauth", access: "a", expires: now + 60_000 },
			{ type: "oauth" },
		]) {
			assert.throws(
				() => validateCursorHostOAuthCredential(malformed as never, now),
				(error: unknown) =>
					error instanceof CursorError && error.code === "AuthenticationMalformed" && error.operation === "authentication",
			);
		}
	});
});

describe("Cursor exact route references", () => {
	test("preserves order, duplicates, exact IDs, and Max tri-state", () => {
		const references = createCursorRouteReferences("cursor-account-v1:scope", 7, [
			{ modelId: " A ", maxMode: undefined },
			{ modelId: "B", maxMode: false },
			{ modelId: " A ", maxMode: undefined },
			{ modelId: " A ", maxMode: false },
			{ modelId: " A ", maxMode: true },
		]);
		assert.deepEqual(references.map((reference) => [reference.routeId, reference.maxMode, reference.occurrence]), [
			[" A ", undefined, 1],
			["B", false, 1],
			[" A ", undefined, 2],
			[" A ", false, 1],
			[" A ", true, 1],
		]);
	});

	test("round-trips a versioned plain selection record including absent Max", () => {
		const [reference] = createCursorRouteReferences("cursor-account-v1:scope", 2, [{ modelId: "A", maxMode: undefined }]);
		assert.ok(reference);
		const record = toCursorSelectionRecord(reference);
		assert.deepEqual(record, {
			version: CURSOR_SELECTION_VERSION,
			provider: "cursor",
			accountScope: "cursor-account-v1:scope",
			routeId: "A",
			maxMode: "absent",
			occurrence: 1,
		});
		assert.deepEqual(parseCursorSelectionRecord(record), record);
		assert.equal(parseCursorSelectionRecord({ ...record, version: 0 }), undefined);
		// Same-version metadata is ignored and cannot influence named identity fields.
		assert.deepEqual(parseCursorSelectionRecord({ ...record, extra: "ignored" }), record);
		assert.deepEqual(parseCursorSelectionRecord({ ...record, legacyAlias: "ignored" }), record);
		// Missing or malformed required identity fields are still rejected.
		assert.equal(parseCursorSelectionRecord({ ...record, routeId: "" }), undefined);
		assert.equal(parseCursorSelectionRecord({ ...record, occurrence: 0 }), undefined);
	});
});
