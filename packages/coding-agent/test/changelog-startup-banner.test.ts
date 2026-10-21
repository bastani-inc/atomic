import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ path: "" }));

vi.mock("../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/config.ts")>()),
	VERSION: "1.0.0",
	getChangelogPath: () => fixture.path,
}));

const { SettingsManager } = await import("../src/core/settings-manager.ts");
const { InteractiveMode } = await import("../src/modes/interactive/interactive-mode.ts");

const workDir = mkdtempSync(join(tmpdir(), "atomic-changelog-banner-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function bannerFor(changelog: string): string | undefined {
	fixture.path = join(workDir, "CHANGELOG.md");
	writeFileSync(fixture.path, changelog);
	const settingsManager = SettingsManager.inMemory();
	settingsManager.setLastChangelogVersion("0.9.0");
	const host = {
		session: { state: { messages: [] } },
		settingsManager,
		reportInstallTelemetry: vi.fn(),
	};
	const getChangelogForDisplay = Reflect.get(InteractiveMode.prototype, "getChangelogForDisplay") as (
		this: typeof host,
	) => string | undefined;
	return getChangelogForDisplay.call(host);
}

describe("What's New startup banner", () => {
	it("shows the release highlights and points to /changelog instead of the full list (#3804)", () => {
		const banner = bannerFor(
			[
				"# Changelog",
				"",
				"## [1.0.0] - 2026-01-01",
				"",
				"Calmer sessions.",
				"",
				"- **Quicker start:** boots sooner. ([#1](docs/start.md))",
				"",
				"### Fixed",
				"",
				"- detailed fix entry",
				"",
				"## [0.9.0] - 2025-12-01",
				"",
				"### Fixed",
				"",
				"- older fix",
			].join("\n"),
		);

		expect(banner).toContain("## [1.0.0] - 2026-01-01");
		expect(banner).toContain("Calmer sessions.");
		expect(banner).toContain(
			"- **Quicker start:** boots sooner. ([#1](https://github.com/bastani-inc/atomic/blob/1.0.0/packages/coding-agent/docs/start.md))",
		);
		expect(banner).toContain("/changelog");
		expect(banner).not.toContain("detailed fix entry");
		expect(banner).not.toContain("older fix");
	});

	it("keeps showing the full entry when the release has no highlights (#3804)", () => {
		const banner = bannerFor(
			["# Changelog", "", "## [1.0.0] - 2026-01-01", "", "### Fixed", "", "- detailed fix entry"].join("\n"),
		);

		expect(banner).toBe("## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- detailed fix entry");
	});
});
