/**
 * Test for BMP to PNG conversion in clipboard image handling.
 * Separate from clipboard-image.test.ts due to different mocking requirements.
 *
 * This tests the fix for WSL2/WSLg where clipboard often provides image/bmp
 * instead of image/png.
 */
import { describe, expect, test, vi } from "vitest";

// The simulated platform's programs are the mocked child processes, so every helper is found under its own name.
vi.mock("../src/utils/helper-command.ts", () => ({
	findHelperExecutable: (name: string) => name,
	findHelperExecutableAsync: async (name: string) => name,
	helperLaunch: (name: string) => ({ file: name }),
	helperLaunchAsync: async (name: string) => ({ file: name }),
	missingHelperOptions: () => ({}),
}));

function createTinyBmp1x1Red24bpp(): Uint8Array {
	// Minimal 1x1 24bpp BMP (BGR + row padding to 4 bytes)
	// File size = 14 (BMP header) + 40 (DIB header) + 4 (pixel row) = 58
	const buffer = Buffer.alloc(58);

	// BITMAPFILEHEADER
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2); // file size
	buffer.writeUInt16LE(0, 6); // reserved1
	buffer.writeUInt16LE(0, 8); // reserved2
	buffer.writeUInt32LE(54, 10); // pixel data offset

	// BITMAPINFOHEADER
	buffer.writeUInt32LE(40, 14); // DIB header size
	buffer.writeInt32LE(1, 18); // width
	buffer.writeInt32LE(1, 22); // height (positive = bottom-up)
	buffer.writeUInt16LE(1, 26); // planes
	buffer.writeUInt16LE(24, 28); // bits per pixel
	buffer.writeUInt32LE(0, 30); // compression (BI_RGB)
	buffer.writeUInt32LE(4, 34); // image size (incl. padding)
	buffer.writeInt32LE(0, 38); // x pixels per meter
	buffer.writeInt32LE(0, 42); // y pixels per meter
	buffer.writeUInt32LE(0, 46); // colors used
	buffer.writeUInt32LE(0, 50); // important colors

	// Pixel data (B, G, R) + 1 byte padding
	buffer[54] = 0x00; // B
	buffer[55] = 0x00; // G
	buffer[56] = 0xff; // R
	buffer[57] = 0x00; // padding

	return new Uint8Array(buffer);
}

// Mock wl-paste to return BMP
vi.mock("child_process", async () => {
	const actual = await vi.importActual<typeof import("child_process")>("child_process");
	return {
		...actual,
		execFile: vi.fn(
			(
				command: string,
				args: string[],
				_options: unknown,
				callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
			) => {
				if (command === "wl-paste" && args.includes("--list-types")) {
					callback(null, Buffer.from("image/bmp\n"), Buffer.alloc(0));
					return;
				}
				if (command === "wl-paste" && args.includes("image/bmp")) {
					callback(null, Buffer.from(createTinyBmp1x1Red24bpp()), Buffer.alloc(0));
					return;
				}
				callback(new Error("failed"), Buffer.alloc(0), Buffer.alloc(0));
			},
		),
	};
});

// Mock the native clipboard (not used in Wayland path, but needs to be mocked)
vi.mock("@mariozechner/clipboard", () => ({
	default: {
		hasImage: vi.fn(() => false),
		getImageBinary: vi.fn(() => Promise.resolve(null)),
	},
}));

describe("readClipboardImage BMP conversion", () => {
	test("converts BMP to PNG on Wayland/WSLg", async () => {
		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");

		// Simulate Wayland session (WSLg)
		const image = await readClipboardImage({
			env: { WAYLAND_DISPLAY: "wayland-0" },
			platform: "linux",
		});

		expect(image).not.toBeNull();
		expect(image!.mimeType).toBe("image/png");

		// Verify PNG magic bytes
		expect(image!.bytes[0]).toBe(0x89);
		expect(image!.bytes[1]).toBe(0x50); // P
		expect(image!.bytes[2]).toBe(0x4e); // N
		expect(image!.bytes[3]).toBe(0x47); // G
	});
});
