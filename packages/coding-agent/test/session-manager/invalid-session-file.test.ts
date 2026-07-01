import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager.open rejects invalid non-empty session files", () => {
	it("throws a friendly error and preserves the original file content", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "atomic-invalid-session-"));
		const sessionFile = join(tempDir, "not-a-session.log");
		const originalContent = '{"type":"event","data":"not a session"}\n';
		writeFileSync(sessionFile, originalContent);

		expect(() => SessionManager.open(sessionFile, tempDir)).toThrow(
			`Session file is not a valid pi session: ${sessionFile}`,
		);
		// The invalid file must not be modified or truncated.
		expect(readFileSync(sessionFile, "utf8")).toBe(originalContent);
	});

	it("initializes a valid header for an empty file instead of throwing", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "atomic-empty-session-"));
		const sessionFile = join(tempDir, "empty.jsonl");
		writeFileSync(sessionFile, "");

		const session = SessionManager.open(sessionFile, tempDir);
		expect(session.getHeader()).not.toBeNull();
		expect(session.getSessionId()).toBeDefined();
	});
});
