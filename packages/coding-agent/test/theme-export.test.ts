import assert from "node:assert/strict";
import { colorToHex, parseColor } from "@earendil-works/pi-tui";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getResolvedThemeColors, getThemeByName, getThemeExportColors } from "../src/modes/interactive/theme/theme.js";

type ThemeFile = {
	name: string;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
	export?: {
		pageBg?: string | number;
		cardBg?: string | number;
		infoBg?: string | number;
	};
};

describe("getThemeExportColors", () => {
	let tempRoot: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-theme-export-"));
		previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
		process.env.ATOMIC_CODING_AGENT_DIR = join(tempRoot, "agent");
		mkdirSync(join(process.env.ATOMIC_CODING_AGENT_DIR, "themes"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
		if (previousAgentDir === undefined) {
			delete process.env.ATOMIC_CODING_AGENT_DIR;
		} else {
			process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("resolves export variable references using the same syntax as colors", () => {
		const darkTheme = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
		) as ThemeFile;

		const customTheme: ThemeFile = {
			...darkTheme,
			name: "custom-export-vars",
			vars: {
				...(darkTheme.vars ?? {}),
				pageBgVar: "#112233",
				pageBgAlias: "pageBgVar",
				infoBgVar: "#445566",
				cardBgVar: "#223344",
			},
			export: {
				pageBg: "pageBgAlias",
				cardBg: "cardBgVar",
				infoBg: "infoBgVar",
			},
		};

		writeFileSync(
			join(process.env.ATOMIC_CODING_AGENT_DIR!, "themes", "custom-export-vars.json"),
			JSON.stringify(customTheme, null, 2),
		);

		expect(getThemeExportColors("custom-export-vars")).toEqual({
			pageBg: "#112233",
			cardBg: "#223344",
			infoBg: "#445566",
		});
	});

	it("resolves recursive vars and converts 256-color export values to hex", () => {
		const darkTheme = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
		) as ThemeFile;

		const customTheme: ThemeFile = {
			...darkTheme,
			name: "custom-export-recursive",
			vars: {
				...(darkTheme.vars ?? {}),
				deepPageBg: "#abcdef",
				pageBgAlias: "deepPageBg",
				cardBgAnsi: 24,
			},
			export: {
				pageBg: "pageBgAlias",
				cardBg: "cardBgAnsi",
				infoBg: "",
			},
		};

		writeFileSync(
			join(process.env.ATOMIC_CODING_AGENT_DIR!, "themes", "custom-export-recursive.json"),
			JSON.stringify(customTheme, null, 2),
		);

		expect(getThemeExportColors("custom-export-recursive")).toEqual({
			pageBg: "#abcdef",
			cardBg: "#005f87",
			infoBg: undefined,
		});
	});
	it("renders and exports OKHSL values in existing custom themes", () => {
		const darkTheme = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
		) as ThemeFile;
		const color = "okhsl(295 0.6 0.5)";
		const custom = {
			...darkTheme,
			name: "custom-okhsl",
			colors: { ...darkTheme.colors, accent: color },
			export: { pageBg: color },
		};
		writeFileSync(join(process.env.ATOMIC_CODING_AGENT_DIR!, "themes", "custom-okhsl.json"), JSON.stringify(custom));
		assert.ok(getThemeByName("custom-okhsl")?.getFgAnsi("accent"));
		assert.equal(getResolvedThemeColors("custom-okhsl").accent, colorToHex(parseColor(color)));
		assert.equal(getThemeExportColors("custom-okhsl").pageBg, colorToHex(parseColor(color)));
	});
});
