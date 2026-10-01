import type { TerminalColors } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	detectTerminalBackgroundFromEnv,
	detectTerminalBackgroundTheme,
	detectTerminalThemeForAuto,
	getThemeForRgbColor,
	parseAutoThemeSetting,
	resolveThemeSetting,
} from "../src/modes/interactive/theme/theme.ts";

describe("detectTerminalBackgroundFromEnv", () => {
	it("uses the COLORFGBG background color index", () => {
		expect(detectTerminalBackgroundFromEnv({ env: { COLORFGBG: "0;15" } })).toMatchObject({
			theme: "light",
			source: "COLORFGBG",
			confidence: "high",
		});
		expect(detectTerminalBackgroundFromEnv({ env: { COLORFGBG: "15;0" } })).toMatchObject({
			theme: "dark",
			source: "COLORFGBG",
			confidence: "high",
		});
	});

	it("uses the last COLORFGBG field as the background", () => {
		expect(detectTerminalBackgroundFromEnv({ env: { COLORFGBG: "0;7;15" } }).theme).toBe("light");
	});

	it("defaults to dark without terminal background hints", () => {
		expect(detectTerminalBackgroundFromEnv({ env: {} })).toMatchObject({
			theme: "dark",
			source: "fallback",
			confidence: "low",
		});
	});
});

describe("detectTerminalBackgroundTheme", () => {
	it("uses the queried terminal background before environment hints", async () => {
		let queriedTimeoutMs: number | undefined;
		const detection = await detectTerminalBackgroundTheme({
			env: { COLORFGBG: "15;0" },
			timeoutMs: 250,
			ui: {
				async queryTerminalColors({ timeoutMs }: { timeoutMs: number }): Promise<TerminalColors> {
					queriedTimeoutMs = timeoutMs;
					return { background: { r: 250, g: 250, b: 250 } };
				},
			},
		});

		expect(queriedTimeoutMs).toBe(250);
		expect(detection).toMatchObject({
			theme: "light",
			source: "terminal background",
			confidence: "high",
		});
	});

	it("falls back to environment hints when the terminal query returns no color", async () => {
		const detection = await detectTerminalBackgroundTheme({
			env: { COLORFGBG: "15;0" },
			timeoutMs: 250,
			ui: {
				async queryTerminalColors(): Promise<TerminalColors> {
					return {};
				},
			},
		});

		expect(detection).toMatchObject({
			theme: "dark",
			source: "COLORFGBG",
			confidence: "high",
		});
	});

	it("falls back to environment hints when the terminal query fails", async () => {
		const detection = await detectTerminalBackgroundTheme({
			env: { COLORFGBG: "0;15" },
			timeoutMs: 250,
			ui: {
				async queryTerminalColors(): Promise<TerminalColors> {
					throw new Error("terminal write failed");
				},
			},
		});

		expect(detection).toMatchObject({
			theme: "light",
			source: "COLORFGBG",
			confidence: "high",
		});
	});
});

describe("detectTerminalThemeForAuto", () => {
	it("uses one terminal color query for automatic theme detection", async () => {
		let calls = 0;
		await expect(
			detectTerminalThemeForAuto({
				timeoutMs: 100,
				ui: {
					async queryTerminalColors() {
						calls++;
						return { background: { r: 255, g: 255, b: 255 } };
					},
				},
			}),
		).resolves.toBe("light");
		expect(calls).toBe(1);
	});
});

describe("theme detection from RGB", () => {
	it("classifies RGB colors by luminance", () => {
		expect(getThemeForRgbColor({ r: 8, g: 8, b: 8 })).toBe("dark");
		expect(getThemeForRgbColor({ r: 250, g: 250, b: 250 })).toBe("light");
	});
});

describe("theme setting helpers", () => {
	it("parses and resolves automatic theme settings", () => {
		expect(parseAutoThemeSetting("light/dark")).toEqual({ lightTheme: "light", darkTheme: "dark" });
		expect(resolveThemeSetting("dark", "light")).toBe("dark");
		expect(resolveThemeSetting("light/dark", "light")).toBe("light");
		expect(resolveThemeSetting("light/dark", "dark")).toBe("dark");
		expect(resolveThemeSetting("light/dark/extra", "dark")).toBeUndefined();
	});
});
