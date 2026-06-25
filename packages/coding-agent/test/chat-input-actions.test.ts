import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cleanupStaleClipboardFiles,
	openExternalEditorForText,
} from "../src/modes/interactive/chat-input-actions.ts";

const createdDirs: string[] = [];
const createdPaths: string[] = [];

afterEach(() => {
	for (const filePath of createdPaths.splice(0)) {
		fs.rmSync(filePath, { recursive: true, force: true });
	}
	for (const dir of createdDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

const describeExternalEditor = process.platform === "win32" ? describe.skip : describe;

describeExternalEditor("openExternalEditorForText", () => {
	it("uses an unpredictable atomic-branded temp file", () => {
		const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-editor-test-"));
		createdDirs.push(testDir);
		const capturedPathFile = path.join(testDir, "captured-path.txt");
		const editorScript = path.join(testDir, "editor.sh");
		fs.writeFileSync(
			editorScript,
			`#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(capturedPathFile)}\nprintf '\\nupdated' >> "$1"\n`,
			{ mode: 0o700 },
		);

		const host = {
			stop: () => {},
			start: () => {},
			requestRender: () => {},
		};

		const updated = openExternalEditorForText("initial", host, {
			editorCommand: editorScript,
		});

		expect(updated).toBe("initial\nupdated");
		const tmpFile = fs.readFileSync(capturedPathFile, "utf-8");
		expect(path.basename(tmpFile)).toMatch(
			/^atomic-editor-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.atomic\.md$/i,
		);
		expect(fs.existsSync(tmpFile)).toBe(false);
	});

	it("opens quoted editor commands whose paths contain spaces", () => {
		const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic editor test-"));
		createdDirs.push(testDir);
		const editorScript = path.join(testDir, "editor with spaces.sh");
		fs.writeFileSync(
			editorScript,
			`#!/bin/sh\nprintf '\\nquoted command worked' >> "$1"\n`,
			{ mode: 0o700 },
		);

		const host = {
			stop: () => {},
			start: () => {},
			requestRender: () => {},
		};

		const updated = openExternalEditorForText("initial", host, {
			editorCommand: `${JSON.stringify(editorScript)}`,
		});

		expect(updated).toBe("initial\nquoted command worked");
	});
});

describe("cleanupStaleClipboardFiles", () => {
	it("removes only stale atomic clipboard files", () => {
		const now = Date.now();
		const oldFile = path.join(os.tmpdir(), "atomic-clipboard-old-test.png");
		const freshFile = path.join(os.tmpdir(), "atomic-clipboard-fresh-test.png");
		const oldDir = path.join(os.tmpdir(), "atomic-clipboard-old-test-dir");
		createdPaths.push(oldFile, freshFile, oldDir);

		fs.writeFileSync(oldFile, "old");
		fs.writeFileSync(freshFile, "fresh");
		fs.mkdirSync(oldDir, { recursive: true });
		const oldTime = new Date(now - 25 * 60 * 60 * 1000);
		fs.utimesSync(oldFile, oldTime, oldTime);
		fs.utimesSync(oldDir, oldTime, oldTime);

		cleanupStaleClipboardFiles(now);

		expect(fs.existsSync(oldFile)).toBe(false);
		expect(fs.existsSync(freshFile)).toBe(true);
		expect(fs.existsSync(oldDir)).toBe(true);
	});
});
