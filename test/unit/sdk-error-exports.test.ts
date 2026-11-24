import assert from "node:assert/strict";
import {
	attachSessionClaim,
	claimSession,
	JsonlStoragePoisonedError,
	MemorySessionStore,
	OAuthLoginTransactionError,
	prepareSessionClaim,
	resolveModelScopeFromModels,
	resolveModelScopeWithDiagnostics,
	SESSION_ALREADY_OPEN_EXIT_CODE,
	SessionAlreadyOpenError,
	SessionConflictError,
	SessionDeletedError,
	SessionExistsError,
	SessionFormatVersionError,
	SessionIdMismatchError,
	SessionImportFileNotFoundError,
	SessionInvalidTextError,
	SessionInvalidTimestampError,
	SessionNotFoundError,
	SessionOpenElsewhereError,
	SessionWorkUnsettledError,
	SettingsFileChangedError,
	SqlSessionStore,
	StorageImportIncompleteError,
	StorageTransferError,
} from "@bastani/atomic";
import { describe, test } from "vitest";

describe("SDK error and model-scope exports", () => {
	test("exports session concurrency, lifecycle, and storage error classes", () => {
		const alreadyOpen = new SessionAlreadyOpenError("sess-1", { pid: 1234, host: "host-a" });
		assert.ok(alreadyOpen instanceof SessionAlreadyOpenError);
		assert.ok(alreadyOpen instanceof Error);
		assert.equal(alreadyOpen.exitCode, SESSION_ALREADY_OPEN_EXIT_CODE);
		assert.equal(alreadyOpen.pid, 1234);

		const conflict = new SessionConflictError("sess-1", 3, 5);
		assert.ok(conflict instanceof SessionConflictError);
		assert.equal(conflict.expectedSeq, 3);
		assert.equal(conflict.actualSeq, 5);

		const deleted = new SessionDeletedError("sess-1");
		assert.ok(deleted instanceof SessionDeletedError);

		const openElsewhere = new SessionOpenElsewhereError("sess-1", { pid: 5678, host: "host-b" });
		assert.ok(openElsewhere instanceof SessionOpenElsewhereError);

		const notFound = new SessionNotFoundError("sess-missing");
		assert.ok(notFound instanceof SessionNotFoundError);

		const exists = new SessionExistsError("sess-dup");
		assert.ok(exists instanceof SessionExistsError);

		const formatVersion = new SessionFormatVersionError("/tmp/session.jsonl", 99);
		assert.ok(formatVersion instanceof SessionFormatVersionError);

		const idMismatch = new SessionIdMismatchError("sess-a", "sess-b");
		assert.ok(idMismatch instanceof SessionIdMismatchError);

		const invalidText = new SessionInvalidTextError("header.cwd", "nul-character");
		assert.ok(invalidText instanceof SessionInvalidTextError);

		const invalidTimestamp = new SessionInvalidTimestampError("entry.timestamp", "bad", "unparseable");
		assert.ok(invalidTimestamp instanceof SessionInvalidTimestampError);

		const importNotFound = new SessionImportFileNotFoundError("/tmp/missing.jsonl");
		assert.ok(importNotFound instanceof SessionImportFileNotFoundError);

		const unsettled = new SessionWorkUnsettledError("abort", 1, 5000);
		assert.ok(unsettled instanceof SessionWorkUnsettledError);

		const poisoned = new JsonlStoragePoisonedError("/tmp", new Error("io"), new Error("rollback"));
		assert.ok(poisoned instanceof JsonlStoragePoisonedError);

		const settingsChanged = new SettingsFileChangedError("/tmp/settings.json");
		assert.ok(settingsChanged instanceof SettingsFileChangedError);

		const transferError = new StorageTransferError({ path: "/tmp/out.jsonl", reason: "invalid" });
		assert.ok(transferError instanceof StorageTransferError);

		const incomplete = new StorageImportIncompleteError(new Error("boom"), {
			written: { sessions: ["s1"] },
			notWritten: { sessions: ["s2"] },
		});
		assert.ok(incomplete instanceof StorageImportIncompleteError);

		const oauthTx = new OAuthLoginTransactionError(new Error("disk full"));
		assert.ok(oauthTx instanceof OAuthLoginTransactionError);
	});

	test("exports model-scope resolution helpers, MemorySessionStore, and session claim helpers", () => {
		assert.equal(typeof resolveModelScopeFromModels, "function");
		assert.equal(typeof resolveModelScopeWithDiagnostics, "function");
		assert.equal(typeof claimSession, "function");
		assert.equal(typeof prepareSessionClaim, "function");
		assert.equal(typeof attachSessionClaim, "function");
		const store = new MemorySessionStore();
		assert.equal(store.descriptor.adapter, "memory");
		assert.equal(typeof SqlSessionStore.open, "function");
		const result = resolveModelScopeFromModels([], []);
		assert.deepEqual(result.scopedModels, []);
		assert.deepEqual(result.diagnostics, []);
	});
});
