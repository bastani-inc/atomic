import { describe, expect, test, vi } from "vitest";
import {
	type ClipboardModule,
	createNativeClipboardGetter,
	loadClipboardNative,
} from "../src/utils/clipboard-native.ts";

type ClipboardRequire = (id: string) => unknown;

const fakeClipboard: ClipboardModule = {
	setText: async () => {},
	hasImage: () => true,
	getImageBinary: async () => [1, 2, 3],
};

describe("loadClipboardNative", () => {
	test("falls back to the next require root", () => {
		const primary = vi.fn<ClipboardRequire>(() => {
			throw new Error("missing from bundled root");
		});
		const fallback = vi.fn<ClipboardRequire>(() => fakeClipboard);

		expect(loadClipboardNative([primary, fallback])).toBe(fakeClipboard);
		expect(primary).toHaveBeenCalledWith("@mariozechner/clipboard");
		expect(fallback).toHaveBeenCalledWith("@mariozechner/clipboard");
	});

	test("returns null when no require root can load clipboard", () => {
		const missing = vi.fn<ClipboardRequire>(() => {
			throw new Error("missing");
		});

		expect(loadClipboardNative([missing])).toBeNull();
	});
});

describe("createNativeClipboardGetter", () => {
	test("loads nothing until the first call, then loads once", () => {
		const load = vi.fn<() => ClipboardModule | null>(() => fakeClipboard);
		const getClipboard = createNativeClipboardGetter(true, load);
		expect(load).not.toHaveBeenCalled();

		expect(getClipboard()).toBe(fakeClipboard);
		expect(getClipboard()).toBe(fakeClipboard);
		expect(load).toHaveBeenCalledTimes(1);
	});

	test("remembers a module that could not load", () => {
		const load = vi.fn<() => ClipboardModule | null>(() => null);
		const getClipboard = createNativeClipboardGetter(true, load);

		expect(getClipboard()).toBeNull();
		expect(getClipboard()).toBeNull();
		expect(load).toHaveBeenCalledTimes(1);
	});

	test("never loads where the native module is not used", () => {
		const load = vi.fn<() => ClipboardModule | null>(() => fakeClipboard);
		const getClipboard = createNativeClipboardGetter(false, load);

		expect(getClipboard()).toBeNull();
		expect(load).not.toHaveBeenCalled();
	});
});
