import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container } from "@bastani/atomic-tui";
import { afterAll, beforeAll, describe, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ path: "" }));

vi.mock("../src/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/config.js")>()),
	VERSION: "1.0.0",
	getChangelogPath: () => fixture.path,
}));

const { SettingsManager } = await import("../src/core/settings-manager.js");
const { InteractiveMode } = await import("../src/modes/interactive/interactive-mode.js");
const { parseChangelog } = await import("../src/utils/changelog.js");
const { initTheme } = await import("../src/modes/interactive/theme/theme.js");
const { stripAnsi } = await import("../src/utils/ansi.js");

const workDir = mkdtempSync(join(tmpdir(), "atomic-changelog-banner-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));
beforeAll(() => initTheme("dark"));

function bannerFor(changelog: string): string | undefined {
	fixture.path = join(workDir, "CHANGELOG.md");
	writeFileSync(fixture.path, changelog);
	parseChangelog(fixture.path);
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

		assert.ok(banner !== undefined);
		assert.ok(banner.includes("## [1.0.0] - 2026-01-01"));
		assert.ok(banner.includes("Calmer sessions."));
		assert.ok(
			banner.includes(
				"- **Quicker start:** boots sooner. ([#1](https://github.com/bastani-inc/atomic/blob/1.0.0/packages/coding-agent/docs/start.md))",
			),
		);
		assert.ok(banner.includes("/changelog"));
		assert.ok(!banner.includes("detailed fix entry"));
		assert.ok(!banner.includes("older fix"));
	});

	it("keeps showing the full entry when the release has no highlights (#3804)", () => {
		const banner = bannerFor(
			["# Changelog", "", "## [1.0.0] - 2026-01-01", "", "### Fixed", "", "- detailed fix entry"].join("\n"),
		);

		assert.equal(banner, "## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- detailed fix entry");
	});

	it("shows What's New when deferred startup readies input before reading the changelog", async () => {
		fixture.path = join(workDir, "DEFERRED-CHANGELOG.md");
		writeFileSync(fixture.path, "# Changelog\n\n## [1.0.0] - 2026-01-01\n\nCalmer sessions.\n");
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setLastChangelogVersion("0.9.0");
		const prototypeMethod = (name: string) => Reflect.get(InteractiveMode.prototype, name);
		const host = {
			pendingUserInputs: [],
			inputHandlerReadyRecorded: false,
			deferredStartupPending: true,
			ensureDeferredStartupComplete: async () => undefined,
			footerDataProvider: { startGitWatcher: () => undefined },
			startupNoticesShown: false,
			startupNoticesPrepared: false,
			firstRunNoticeVisible: false,
			version: "1.0.0",
			startupNoticesContainer: new Container(),
			ui: { requestRender: () => undefined },
			session: { state: { messages: [] }, extensionRunner: { getMarkdownTransformers: () => [] } },
			runtimeHost: {},
			settingsManager,
			reportInstallTelemetry: vi.fn(),
			getChangelogForDisplay: prototypeMethod("getChangelogForDisplay"),
			showStartupNoticesIfNeeded: prototypeMethod("showStartupNoticesIfNeeded"),
			createChangelogMarkdown: prototypeMethod("createChangelogMarkdown"),
			getMarkdownThemeWithSettings: prototypeMethod("getMarkdownThemeWithSettings"),
			getMarkdownTransformers: prototypeMethod("getMarkdownTransformers"),
		};
		const getUserInput = prototypeMethod("getUserInput") as (this: typeof host) => Promise<void>;

		void getUserInput.call(host);

		await vi.waitFor(() => assert.equal(host.startupNoticesShown, true));
		const rendered = stripAnsi(host.startupNoticesContainer.render(100).join("\n"));
		assert.ok(rendered.includes("What's New"));
		assert.ok(rendered.includes("Calmer sessions."));
	});
});
