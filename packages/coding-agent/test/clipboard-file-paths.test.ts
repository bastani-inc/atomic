import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { readClipboardFilePaths } from "../src/utils/clipboard.js";

type ExecFileCallback = (error: Error | null, stdout?: string, stderr?: string) => void;

const execFile = vi.hoisted(() =>
	vi.fn<(file: string, args: string[], options: object, callback: ExecFileCallback) => void>(),
);

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("child_process")>()),
	execFile,
}));

beforeEach(() => {
	execFile.mockReset();
});

const withFileUrls = { availableFormats: () => ["public.file-url", "NSFilenamesPboardType"] };

test("reads copied file paths on macOS through AppKit", async () => {
	execFile.mockImplementation((_file, _args, _options, callback) =>
		callback(null, '["/tmp/My Photos/photo.png","/tmp/notes.txt"]\n'),
	);

	assert.deepEqual(await readClipboardFilePaths(withFileUrls, "darwin"), [
		"/tmp/My Photos/photo.png",
		"/tmp/notes.txt",
	]);
	assert.equal(execFile.mock.calls[0]?.[0], "osascript");
	assert.deepEqual(execFile.mock.calls[0]?.[1].slice(0, 2), ["-l", "JavaScript"]);
});

test("does not start a process when the clipboard holds no file URLs or the platform is not macOS", async () => {
	assert.equal(await readClipboardFilePaths({ availableFormats: () => ["public.utf8-plain-text"] }, "darwin"), null);
	assert.equal(await readClipboardFilePaths({}, "darwin"), null);
	assert.equal(await readClipboardFilePaths(null, "darwin"), null);
	assert.equal(await readClipboardFilePaths(withFileUrls, "linux"), null);
	assert.equal(execFile.mock.calls.length, 0);
});

test("rejects with osascript's error output when AppKit cannot be read, so paste reports it instead of pasting the file icon", async () => {
	execFile.mockImplementation((_file, args, _options, callback) =>
		callback(
			new Error(`Command failed: osascript ${args.join(" ")}`),
			"",
			"execution error: Error: AppKit is unavailable (-2700)\n",
		),
	);

	await assert.rejects(readClipboardFilePaths(withFileUrls, "darwin"), {
		message: "osascript could not read the copied files: execution error: Error: AppKit is unavailable (-2700)",
	});
});
