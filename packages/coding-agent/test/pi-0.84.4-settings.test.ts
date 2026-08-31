import {
	detectCapabilities,
	getCapabilities,
	resetCapabilitiesCache,
	setCapabilityOverrides,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";

const capabilityEnvironment = [
	"TERM",
	"TERM_PROGRAM",
	"COLORTERM",
	"KITTY_WINDOW_ID",
	"PI_HYPERLINKS",
	"PI_IMAGE_PROTOCOL",
	"PI_TRUE_COLOR",
] as const;
const savedEnvironment = Object.fromEntries(capabilityEnvironment.map((key) => [key, process.env[key]]));

afterEach(() => {
	for (const key of capabilityEnvironment) {
		const value = savedEnvironment[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	setCapabilityOverrides({});
	resetCapabilitiesCache();
});

describe("pi-tui 0.84.4 settings", () => {
	test("maps explicit terminal capability settings and omits auto, unset, and invalid values", () => {
		expect(
			SettingsManager.inMemory({
				terminal: { hyperlinks: false, images: "kitty", trueColor: true },
			}).getTerminalCapabilityOverrides(),
		).toEqual({ hyperlinks: false, images: "kitty", trueColor: true });
		expect(SettingsManager.inMemory({ terminal: { images: false } }).getTerminalCapabilityOverrides()).toEqual({
			images: null,
		});
		expect(
			SettingsManager.inMemory({
				terminal: { hyperlinks: "auto", images: "auto", trueColor: "auto" },
			}).getTerminalCapabilityOverrides(),
		).toEqual({});
		expect(
			SettingsManager.inMemory({
				terminal: { hyperlinks: "yes", images: "sixel", trueColor: 1 },
			} as Settings).getTerminalCapabilityOverrides(),
		).toEqual({});
	});

	test("defaults fullscreen copy-on-select to true and persists explicit changes", () => {
		const manager = SettingsManager.inMemory();
		expect(manager.getFullscreenCopyOnSelect()).toBe(true);
		expect(
			SettingsManager.inMemory({ fullscreenCopyOnSelect: "false" } as Settings).getFullscreenCopyOnSelect(),
		).toBe(true);
		manager.setFullscreenCopyOnSelect(false);
		expect(manager.getFullscreenCopyOnSelect()).toBe(false);
		expect(manager.getGlobalSettings().fullscreenCopyOnSelect).toBe(false);
	});

	test("programmatic capability settings override renderer environment values", () => {
		process.env.PI_HYPERLINKS = "1";
		process.env.PI_IMAGE_PROTOCOL = "kitty";
		process.env.PI_TRUE_COLOR = "1";
		expect(detectCapabilities()).toEqual({ images: "kitty", trueColor: true, hyperlinks: true });

		const manager = SettingsManager.inMemory({
			terminal: { hyperlinks: false, images: false, trueColor: false },
		});
		setCapabilityOverrides(manager.getTerminalCapabilityOverrides());
		expect(getCapabilities()).toEqual({ images: null, trueColor: false, hyperlinks: false });
	});
});
