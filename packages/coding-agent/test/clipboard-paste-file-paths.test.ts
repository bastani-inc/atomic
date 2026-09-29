import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { pasteClipboardImageToEditor } from "../src/modes/interactive/chat-input-actions.js";

const mocks = vi.hoisted(() => ({
	readClipboardFilePaths: vi.fn<() => Promise<string[] | null>>(),
	readClipboardImage: vi.fn<() => Promise<{ bytes: Uint8Array; mimeType: string } | null>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/utils/clipboard.js", () => ({
	readClipboardFilePaths: mocks.readClipboardFilePaths,
	readClipboardText: mocks.readClipboardText,
}));
vi.mock("../src/utils/clipboard-image.js", () => ({
	extensionForImageMimeType: () => "png",
	readClipboardImage: mocks.readClipboardImage,
}));

beforeEach(() => {
	vi.resetAllMocks();
});

function createEditor(text = "", col?: number) {
	const inserted: string[] = [];
	return {
		inserted,
		editor: {
			insertTextAtCursor: (value: string) => inserted.push(value),
			getText: () => text,
			...(col === undefined ? {} : { getCursor: () => ({ line: 0, col }) }),
		},
	};
}

test("Finder file paths take precedence over their icon image", async () => {
	const filePaths = ["/tmp/screenshot.png", "/tmp/My Photos/photo.png"];
	mocks.readClipboardFilePaths.mockResolvedValue(filePaths);
	mocks.readClipboardImage.mockResolvedValue({
		bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
		mimeType: "image/png",
	});
	const { editor, inserted } = createEditor();

	assert.equal(await pasteClipboardImageToEditor(editor), true);

	assert.deepEqual(inserted, [filePaths.join("\n")]);
	assert.equal(mocks.readClipboardImage.mock.calls.length, 0);
});

test("clipboard file paths containing terminal control characters are rejected", async () => {
	mocks.readClipboardFilePaths.mockResolvedValue(["/tmp/photo\x1b]0;unsafe\x07.png"]);
	const warnings: string[] = [];
	const { editor, inserted } = createEditor();

	assert.equal(await pasteClipboardImageToEditor(editor, undefined, { showWarning: (m) => warnings.push(m) }), false);

	assert.deepEqual(inserted, []);
	assert.equal(mocks.readClipboardImage.mock.calls.length, 0);
	assert.deepEqual(warnings, ["Failed to paste from clipboard: Clipboard file path contains control characters"]);
});

test("file-path read errors are shown without falling through to the icon image", async () => {
	mocks.readClipboardFilePaths.mockRejectedValue(new Error("Clipboard file read failed"));
	const warnings: string[] = [];
	const { editor, inserted } = createEditor();

	assert.equal(await pasteClipboardImageToEditor(editor, undefined, { showWarning: (m) => warnings.push(m) }), false);

	assert.deepEqual(inserted, []);
	assert.equal(mocks.readClipboardImage.mock.calls.length, 0);
	assert.deepEqual(warnings, ["Failed to paste from clipboard: Clipboard file read failed"]);
});

test.each([
	["punctuation", "Review:", 7],
	["Unicode text", "確認", 2],
])("clipboard file paths are separated from preceding %s", async (_description, editorText, cursorCol) => {
	mocks.readClipboardFilePaths.mockResolvedValue(["/tmp/photo.png"]);
	const { editor, inserted } = createEditor(editorText, cursorCol);

	await pasteClipboardImageToEditor(editor);

	assert.deepEqual(inserted, [" /tmp/photo.png"]);
});

test("bash mode shell-quotes file paths and inserts them as arguments", async () => {
	mocks.readClipboardFilePaths.mockResolvedValue([
		"/tmp/My Photos/photo.png",
		"/tmp/$(touch hacked).png",
		"/tmp/plain.png",
	]);
	const { editor, inserted } = createEditor("catDEST", 3);

	await pasteClipboardImageToEditor(editor, undefined, { isBashMode: true });

	assert.deepEqual(inserted, [" '/tmp/My Photos/photo.png' '/tmp/$(touch hacked).png' /tmp/plain.png "]);
	assert.equal(mocks.readClipboardImage.mock.calls.length, 0);
});

test("without copied files, images and then text are pasted as before", async () => {
	mocks.readClipboardFilePaths.mockResolvedValue(null);
	mocks.readClipboardImage.mockResolvedValue(null);
	mocks.readClipboardText.mockResolvedValue("plain text");
	const { editor, inserted } = createEditor();

	assert.equal(await pasteClipboardImageToEditor(editor), true);

	assert.deepEqual(inserted, ["plain text"]);
});

test("image read errors abort paste without reading text and are reported", async () => {
	mocks.readClipboardFilePaths.mockResolvedValue(null);
	mocks.readClipboardImage.mockRejectedValue(new Error("Native clipboard operation failed"));
	const warnings: string[] = [];
	const requestRender = vi.fn();
	const { editor, inserted } = createEditor();

	assert.equal(
		await pasteClipboardImageToEditor(editor, requestRender, { showWarning: (m) => warnings.push(m) }),
		false,
	);

	assert.equal(mocks.readClipboardText.mock.calls.length, 0);
	assert.deepEqual(inserted, []);
	assert.equal(requestRender.mock.calls.length, 0);
	assert.deepEqual(warnings, ["Failed to paste from clipboard: Native clipboard operation failed"]);
});
