import { describe, expect, it, vi } from "vitest";
import { restoreTerminalTitleAfterPackageCheck } from "../src/modes/interactive/interactive-terminal-title.ts";

describe("Windows startup terminal title restoration", () => {
	it("restores the initialized title after the package check resolves", async () => {
		const restore = vi.fn();
		await expect(
			restoreTerminalTitleAfterPackageCheck(Promise.resolve(["extension"]), {
				platform: "win32",
				initialized: () => true,
				restore,
			}),
		).resolves.toEqual(["extension"]);
		expect(restore).toHaveBeenCalledOnce();
	});

	it("restores the initialized title after the package check rejects", async () => {
		const restore = vi.fn();
		await expect(
			restoreTerminalTitleAfterPackageCheck(Promise.reject(new Error("npm failed")), {
				platform: "win32",
				initialized: () => true,
				restore,
			}),
		).rejects.toThrow("npm failed");
		expect(restore).toHaveBeenCalledOnce();
	});

	it("does not rewrite titles on other platforms or before initialization", async () => {
		const restore = vi.fn();
		await restoreTerminalTitleAfterPackageCheck(Promise.resolve([]), {
			platform: "linux",
			initialized: () => true,
			restore,
		});
		await restoreTerminalTitleAfterPackageCheck(Promise.resolve([]), {
			platform: "win32",
			initialized: () => false,
			restore,
		});
		expect(restore).not.toHaveBeenCalled();
	});
});
