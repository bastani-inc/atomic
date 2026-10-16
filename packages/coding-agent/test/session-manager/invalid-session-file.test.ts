import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SessionFormatVersionError, StorageUnavailableError } from "../../src/core/storage/session/errors.js";

describe("SessionManager.open rejects invalid non-empty session files", () => {
	it("throws a typed format error and preserves the original file content", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "atomic-invalid-session-"));
		const sessionFile = join(tempDir, "not-a-session.log");
		const originalContent = '{"type":"event","data":"not a session"}\n';
		writeFileSync(sessionFile, originalContent);

		await expect(SessionManager.open(sessionFile, tempDir)).rejects.toThrow(SessionFormatVersionError);
		// The invalid file must not be modified or truncated.
		expect(readFileSync(sessionFile, "utf8")).toBe(originalContent);
	});

	it("rejects an empty existing file without rewriting it", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "atomic-empty-session-"));
		const sessionFile = join(tempDir, "empty.jsonl");
		writeFileSync(sessionFile, "");

		await expect(SessionManager.open(sessionFile, tempDir)).rejects.toMatchObject({
			constructor: StorageUnavailableError,
			cause: expect.any(SyntaxError),
		});
		expect(readFileSync(sessionFile, "utf8")).toBe("");
	});
});
