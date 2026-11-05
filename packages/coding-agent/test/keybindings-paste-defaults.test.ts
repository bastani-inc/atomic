import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { KEYBINDINGS, useWindowsKeybindings } from "../src/core/keybindings.ts";

describe("paste keybinding defaults", () => {
	it("keeps ctrl+v as a paste key on WSL (pi #11780)", async () => {
		if (process.platform !== "linux") return;
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		vi.resetModules();
		try {
			const { KEYBINDINGS: wslKeybindings } = await import("../src/core/keybindings.ts");
			assert.deepEqual(wslKeybindings["app.clipboard.pasteImage"].defaultKeys, ["alt+v", "ctrl+v"]);
		} finally {
			vi.unstubAllEnvs();
			vi.resetModules();
		}
	});

	it("applies the detected paste defaults consistently", () => {
		assert.deepEqual(
			KEYBINDINGS["app.clipboard.pasteImage"].defaultKeys,
			useWindowsKeybindings() ? ["alt+v", "ctrl+v"] : "ctrl+v",
		);
	});
});
