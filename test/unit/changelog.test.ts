import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getEntriesForVersion, getNewEntries, parseChangelog } from "../../packages/coding-agent/src/utils/changelog.js";

function writeChangelog(content: string): string {
  const root = mkdtempSync(join(tmpdir(), "atomic-changelog-"));
  const changelogPath = join(root, "CHANGELOG.md");
  writeFileSync(changelogPath, content);
  return changelogPath;
}

describe("changelog parsing", () => {
  test("parses numeric prerelease versions as distinct changelog entries", () => {
    const changelogPath = writeChangelog(`# Changelog

## [0.8.1] - 2026-05-15

### Fixed

- Stable fix.

## [0.8.1-0] - 2026-05-15

### Fixed

- Prerelease fix.
`);

    try {
      const entries = parseChangelog(changelogPath);
      assert.deepEqual(
        entries.map((entry) => entry.version),
        ["0.8.1", "0.8.1-0"],
      );
      assert.equal(entries[0]?.prerelease, null);
      assert.equal(entries[1]?.prerelease, 0);
    } finally {
      rmSync(dirname(changelogPath), { recursive: true, force: true });
    }
  });

  test("bounds update entries to the current Atomic version", () => {
    const changelogPath = writeChangelog(`# Changelog

## [0.10.0] - 2026-05-20

- Current release.

## [0.9.0] - 2026-05-18

- Previous Atomic release.

## [0.8.1-0] - 2026-05-15

- First Atomic prerelease.

## [0.74.0] - 2026-05-07

- Historical upstream Pi release after the version reset.

## [0.10.0] - 2025-01-01

- Historical upstream Pi section with the same version number.
`);

    try {
      const entries = parseChangelog(changelogPath);
      const newEntries = getNewEntries(entries, "0.8.1-0", "0.10.0");

      assert.deepEqual(
        newEntries.map((entry) => entry.version),
        ["0.10.0", "0.9.0"],
      );
      assert.deepEqual(
        getEntriesForVersion(newEntries, "0.10.0").map((entry) => entry.version),
        ["0.10.0"],
      );
    } finally {
      rmSync(dirname(changelogPath), { recursive: true, force: true });
    }
  });
});
