import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePromptImageReferences } from "../src/core/prompt-file-references.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function shellEscapePath(value: string): string {
	return value.replace(/[\\\s]/gu, "\\$&");
}

describe("resolvePromptImageReferences", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createTempDir(): string {
		const tempDir = mkdtempSync(join(tmpdir(), "prompt-file-refs-"));
		tempDirs.push(tempDir);
		return tempDir;
	}

	it("resolves shell-escaped macOS screenshot paths with narrow no-break spaces", async () => {
		const tempDir = createTempDir();
		const imagePath = join(tempDir, "Screenshot 2026-06-22 at 12.06.12\u202fAM.png");
		const escapedImagePath = shellEscapePath(imagePath);
		writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const result = await resolvePromptImageReferences(`what is this a pic of ${escapedImagePath}`, {
			cwd: tempDir,
			autoResizeImages: false,
		});

		expect(result.images).toHaveLength(1);
		expect(result.images[0]?.mimeType).toBe("image/png");
		expect(result.text).toContain(`<file name="${imagePath}"></file>`);
		expect(result.text).toContain("what is this a pic of");
		expect(result.text).not.toContain("\\ ");
	});

	it("resolves unescaped image paths with spaces by using the longest existing image candidate", async () => {
		const tempDir = createTempDir();
		const imagePath = join(tempDir, "Screenshot 2026-06-22 at 12.06.12\u202fAM.png");
		const typedImagePath = join(tempDir, "Screenshot 2026-06-22 at 12.06.12 AM.png");
		writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const result = await resolvePromptImageReferences(`describe ${typedImagePath} please`, {
			cwd: tempDir,
			autoResizeImages: false,
		});

		expect(result.images).toHaveLength(1);
		expect(result.images[0]?.mimeType).toBe("image/png");
		expect(result.text).toBe(`describe <file name="${imagePath}"></file> please`);
	});

	it("resolves file URL image references", async () => {
		const tempDir = createTempDir();
		const imagePath = join(tempDir, "url image.png");
		const fileUrl = new URL(`file://${imagePath}`).href;
		writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const result = await resolvePromptImageReferences(`describe ${fileUrl}`, {
			cwd: tempDir,
			autoResizeImages: false,
		});

		expect(result.images).toHaveLength(1);
		expect(result.images[0]?.mimeType).toBe("image/png");
		expect(result.text).toBe(`describe <file name="${imagePath}"></file>`);
	});

	it("leaves missing path-like text unchanged", async () => {
		const tempDir = createTempDir();
		const missingPath = join(tempDir, "missing image.png");

		const result = await resolvePromptImageReferences(`describe ${missingPath} please`, {
			cwd: tempDir,
			autoResizeImages: false,
		});

		expect(result.images).toHaveLength(0);
		expect(result.text).toBe(`describe ${missingPath} please`);
	});

	it("resolves pasted file tags as image attachments", async () => {
		const tempDir = createTempDir();
		const imagePath = join(tempDir, "atomic-clipboard & tag.png");
		const escapedPath = imagePath.replace(/&/g, "&amp;");
		writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const result = await resolvePromptImageReferences(`can you see this image <file name="${escapedPath}"></file>`, {
			cwd: tempDir,
			autoResizeImages: false,
		});

		expect(result.images).toHaveLength(1);
		expect(result.images[0]?.mimeType).toBe("image/png");
		expect(result.text).toContain(`<file name="${escapedPath}"></file>`);
		expect(result.text).toContain("can you see this image");
	});

	it("resolves multiple images in the same prompt", async () => {
		const tempDir = createTempDir();
		const firstImagePath = join(tempDir, "first.png");
		const secondImagePath = join(tempDir, "second image.png");
		writeFileSync(firstImagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
		writeFileSync(secondImagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const result = await resolvePromptImageReferences(`compare @first.png and @"${secondImagePath}" please`, {
			cwd: tempDir,
			autoResizeImages: false,
		});

		expect(result.images).toHaveLength(2);
		expect(result.images.map((image) => image.mimeType)).toEqual(["image/png", "image/png"]);
		expect(result.text).toBe(
			`compare <file name="${firstImagePath}"></file> and <file name="${secondImagePath}"></file> please`,
		);
	});
});
