import { describe, expect, test } from "vitest";
import { type ChangelogEntry, getChangelogHighlights, normalizeChangelogLinks } from "../src/utils/changelog.ts";

const entry: ChangelogEntry = {
	major: 0,
	minor: 79,
	patch: 0,
	prerelease: null,
	version: "0.79.0",
	content: "",
};

describe("normalizeChangelogLinks", () => {
	test("rewrites package-relative changelog links to tag-pinned GitHub source links", () => {
		const markdown = [
			"[Project Trust](README.md#project-trust)",
			"[Extensions](docs/extensions.md#project_trust)",
			"[Examples](examples/extensions/)",
			"[Root README](../../README.md#supply-chain-hardening)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, entry)).toBe(
			[
				"[Project Trust](https://github.com/bastani-inc/atomic/blob/0.79.0/packages/coding-agent/README.md#project-trust)",
				"[Extensions](https://github.com/bastani-inc/atomic/blob/0.79.0/packages/coding-agent/docs/extensions.md#project_trust)",
				"[Examples](https://github.com/bastani-inc/atomic/tree/0.79.0/packages/coding-agent/examples/extensions/)",
				"[Root README](https://github.com/bastani-inc/atomic/blob/0.79.0/README.md#supply-chain-hardening)",
			].join("\n"),
		);
	});

	test("canonicalizes old repository URLs without changing external links", () => {
		const markdown = [
			"[#5167](https://github.com/earendil-works/pi-mono/pull/5167)",
			"[#4163](https://github.com/badlogic/pi-mono/issues/4163)",
			"[Agent README](https://github.com/badlogic/pi-mono/blob/main/packages/agent/README.md)",
			"[External](https://example.com/docs)",
			"[Local anchor](#settings)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, "0.79.0")).toBe(
			[
				"[#5167](https://github.com/bastani-inc/atomic/pull/5167)",
				"[#4163](https://github.com/bastani-inc/atomic/issues/4163)",
				"[Agent README](https://github.com/bastani-inc/atomic/blob/0.79.0/packages/agent/README.md)",
				"[External](https://example.com/docs)",
				"[Local anchor](#settings)",
			].join("\n"),
		);
	});
});

describe("getChangelogHighlights", () => {
	const withContent = (content: string): ChangelogEntry => ({ ...entry, content });

	test("returns the summary between the version heading and the first section (#3804)", () => {
		const content = [
			"## [0.79.0] - 2026-01-01",
			"",
			"Calmer, faster sessions.",
			"",
			"- **Quicker start:** boots sooner. ([#1](https://github.com/bastani-inc/atomic/pull/1))",
			"",
			"### Added",
			"",
			"- detailed entry",
		].join("\n");

		expect(getChangelogHighlights(withContent(content))).toBe(
			"Calmer, faster sessions.\n\n- **Quicker start:** boots sooner. ([#1](https://github.com/bastani-inc/atomic/pull/1))",
		);
	});

	test("returns undefined when the entry opens straight into sections (#3804)", () => {
		expect(getChangelogHighlights(withContent("## [0.79.0]\n\n### Fixed\n\n- a fix"))).toBeUndefined();
	});

	test("returns undefined for a heading-only entry (#3804)", () => {
		expect(getChangelogHighlights(withContent("## [0.79.0]"))).toBeUndefined();
	});

	test("returns the whole body when the entry has no sections (#3804)", () => {
		expect(getChangelogHighlights(withContent("## [0.79.0]\n\nOnly a summary.\n"))).toBe("Only a summary.");
	});
});
