import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { type ChangelogEntry, parseChangelog } from "../../packages/coding-agent/src/utils/changelog.js";
import { checkChangelogPage, renderChangelogPage } from "../../scripts/sync-changelog-docs.js";

function releases(markdown: string): ChangelogEntry[] {
	const root = mkdtempSync(join(tmpdir(), "atomic-changelog-docs-"));
	try {
		writeFileSync(join(root, "CHANGELOG.md"), markdown);
		return parseChangelog(join(root, "CHANGELOG.md"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** The page body after the frontmatter and the generator's comment. */
function updates(page: string): string {
	return page.slice(page.indexOf("<Update"));
}

const CHANGELOG = `# Changelog

## [Unreleased]

Not released yet.

## [1.3.0-alpha.2] - 2026-11-26

Second alpha.

### Fixed

- Detail.

## [1.3.0-alpha.1] - 2026-11-25

First alpha.

## [1.2.0] - 2026-11-24

Stable theme.

- **Bold lead.** Benefit ([#1](https://github.com/bastani-inc/atomic/pull/1)).

### Added

- Detail.

## [1.2.0-alpha.1] - 2026-11-23

Shipped alpha.

## [1.1.0] - 2026-01-02

### Fixed

- No summary.

## [5.0.0] - 2025-01-01

History inherited from the fork.
`;

test("renders stable releases newest first, with prereleases only above the newest stable release", () => {
	const page = renderChangelogPage(releases(CHANGELOG), new Set());
	assert.match(page, /^---\ntitle: "Changelog"\n/u);
	assert.equal(
		updates(page),
		`<Update label="November 26, 2026" description="1.3.0-alpha.2">

Second alpha.

</Update>

<Update label="November 25, 2026" description="1.3.0-alpha.1">

First alpha.

</Update>

<Update label="November 24, 2026" description="1.2.0">

Stable theme.

- **Bold lead.** Benefit ([#1](https://github.com/bastani-inc/atomic/pull/1)).

</Update>

<Update label="January 2, 2026" description="1.1.0">

See the [1.1.0 release notes on GitHub](https://github.com/bastani-inc/atomic/releases/tag/1.1.0) for what changed.

</Update>
`,
	);
});

test("escapes MDX syntax outside code and points links at the docs site or GitHub", () => {
	const page = renderChangelogPage(
		releases(`# Changelog

## [1.0.0] - 2026-03-04

Asks say "Your ask <id> failed" & {braces} stay text, but \`<id> {x}\` is code.

- **Links.** See [Storage](docs/storage.md#shared-history-forks), [Retired](docs/workflows.md#run), [Readme](../../README.md) and [#5](https://github.com/bastani-inc/atomic/blob/main/x.md).

## [0.8.14] - 2026-02-01

### Fixed

- Old tags start with v.
`),
		new Set(["storage"]),
	);
	assert.equal(
		updates(page),
		`<Update label="March 4, 2026" description="1.0.0">

Asks say "Your ask &lt;id&gt; failed" & \\{braces\\} stay text, but \`<id> {x}\` is code.

- **Links.** See [Storage](/storage#shared-history-forks), [Retired](https://github.com/bastani-inc/atomic/blob/1.0.0/packages/coding-agent/docs/workflows.md#run), [Readme](https://github.com/bastani-inc/atomic/blob/1.0.0/README.md) and [#5](https://github.com/bastani-inc/atomic/blob/main/x.md).

</Update>

<Update label="February 1, 2026" description="0.8.14">

See the [0.8.14 release notes on GitHub](https://github.com/bastani-inc/atomic/releases/tag/v0.8.14) for what changed.

</Update>
`,
	);
});

test("the check accepts a current page or one a single release behind, and rejects anything else", () => {
	const current = releases(CHANGELOG);
	const page = renderChangelogPage(current, new Set());
	assert.equal(checkChangelogPage(page, current, new Set()).status, "current");

	const nextRelease = releases(
		CHANGELOG.replace("## [1.3.0-alpha.2]", "## [1.3.0] - 2026-11-27\n\nShips 1.3.0.\n\n## [1.3.0-alpha.2]"),
	);
	const behind = checkChangelogPage(page, nextRelease, new Set());
	assert.equal(behind.status, "behind");
	assert.match(behind.message, /1\.3\.0/u);

	const twoReleases = releases(
		CHANGELOG.replace(
			"## [1.3.0-alpha.2]",
			"## [1.3.1] - 2026-11-28\n\n## [1.3.0] - 2026-11-27\n\n## [1.3.0-alpha.2]",
		),
	);
	assert.equal(checkChangelogPage(page, twoReleases, new Set()).status, "stale");
	assert.equal(
		checkChangelogPage(page.replace("First alpha.", "Edited by hand."), current, new Set()).status,
		"stale",
	);
});
