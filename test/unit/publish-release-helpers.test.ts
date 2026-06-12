import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  cleanUrl,
  firstActionsUrl,
  firstNonEmptyLine,
  hasLeadingStatus,
  hasStatusMarker,
  prereleaseVersionPattern,
  releaseVersionPattern,
  validateReleaseRequest,
  verifyPullRequestMergedJson,
  verifyReleasePullRequestReferenceJson,
  type JsonValue,
} from "../../.atomic/workflows/lib/publish-release-helpers.js";

describe("publish-release version validation", () => {
  test("accepts stable release versions only for release requests", () => {
    assert.equal(releaseVersionPattern.test("1.2.3"), true);
    assert.equal(releaseVersionPattern.test("1.2.3-alpha.1"), false);

    assert.deepEqual(validateReleaseRequest("release", "1.2.3"), {
      kind: "release",
      version: "1.2.3",
      branch: "release/1.2.3",
    });
    assert.throws(
      () => validateReleaseRequest("release", "1.2.3-alpha.1"),
      /expected MAJOR\.MINOR\.PATCH/u,
    );
  });

  test("accepts alpha prerelease revisions starting at one only for prerelease requests", () => {
    assert.equal(prereleaseVersionPattern.test("1.2.3-alpha.1"), true);
    assert.equal(prereleaseVersionPattern.test("1.2.3-alpha.0"), false);
    assert.equal(prereleaseVersionPattern.test("1.2.3-beta.1"), false);
    assert.equal(prereleaseVersionPattern.test("1.2.3"), false);

    assert.deepEqual(validateReleaseRequest("prerelease", "1.2.3-alpha.1"), {
      kind: "prerelease",
      version: "1.2.3-alpha.1",
      branch: "prerelease/1.2.3-alpha.1",
    });
    assert.throws(
      () => validateReleaseRequest("prerelease", "1.2.3"),
      /expected MAJOR\.MINOR\.PATCH-alpha\.REVISION/u,
    );
  });

  test("rejects versions with a leading v before applying kind-specific validation", () => {
    assert.throws(
      () => validateReleaseRequest("release", "v1.2.3"),
      /must not include a leading "v"/u,
    );
    assert.throws(
      () => validateReleaseRequest("prerelease", "v1.2.3-alpha.1"),
      /must not include a leading "v"/u,
    );
  });
});

describe("publish-release URL extraction", () => {
  test("strips trailing punctuation from URLs", () => {
    assert.equal(
      cleanUrl("https://github.com/earendil-works/pi-mono/pull/123),.;"),
      "https://github.com/earendil-works/pi-mono/pull/123",
    );
  });

  test("selects the first actions run URL and ignores unrelated URLs", () => {
    const text = [
      "Workflow: https://github.com/earendil-works/pi-mono/actions/workflows/publish.yml",
      "Run: https://github.com/earendil-works/pi-mono/actions/runs/987654321)",
      "Later run: https://github.com/earendil-works/pi-mono/actions/runs/123456789",
    ].join("\n");

    assert.equal(firstActionsUrl(text), "https://github.com/earendil-works/pi-mono/actions/runs/987654321");
    assert.equal(firstActionsUrl("Docs: https://example.com/actions."), undefined);
  });
});

describe("publish-release status parsing", () => {
  test("finds the first non-empty line while trimming whitespace and handling CRLF", () => {
    assert.equal(firstNonEmptyLine("\r\n  \r\n  CHECK_STATUS: passed  \r\nbody"), "CHECK_STATUS: passed");
    assert.equal(firstNonEmptyLine("\n\n"), "");
  });

  test("keeps exact leading-status behavior available for strict checks", () => {
    assert.equal(hasLeadingStatus("\n  CHECK_STATUS: passed  \nbody", "CHECK_STATUS: passed"), true);
    assert.equal(hasLeadingStatus("Preamble\nCHECK_STATUS: passed", "CHECK_STATUS: passed"), false);
    assert.equal(hasLeadingStatus("CHECK_STATUS: passed with prose", "CHECK_STATUS: passed"), false);
  });

  test("accepts a standalone status marker even when the model adds a preamble", () => {
    const text = [
      "I verified the checks before reporting success.",
      "CHECK_STATUS: passed",
      "CHECK_RUN: typecheck",
      "CHECK_RUN: test:unit",
    ].join("\n");

    assert.equal(hasStatusMarker(text, "CHECK_STATUS: passed"), true);
  });

  test("uses the last standalone marker for the same status key", () => {
    assert.equal(
      hasStatusMarker("CHECK_STATUS: passed\nCHECK_STATUS: failed", "CHECK_STATUS: passed"),
      false,
    );
    assert.equal(
      hasStatusMarker("CHECK_STATUS: failed\nCHECK_STATUS: passed", "CHECK_STATUS: passed"),
      true,
    );
  });

  test("rejects inline, bulleted, partial, and wrong-key status mentions", () => {
    assert.equal(hasStatusMarker("Result: CHECK_STATUS: passed", "CHECK_STATUS: passed"), false);
    assert.equal(hasStatusMarker("- CHECK_STATUS: passed", "CHECK_STATUS: passed"), false);
    assert.equal(hasStatusMarker("CHECK_STATUS: passed after verification", "CHECK_STATUS: passed"), false);
    assert.equal(hasStatusMarker("PUBLISH_STATUS: passed", "CHECK_STATUS: passed"), false);
  });
});

describe("publish-release GitHub PR reference verification", () => {
  const releasePr: JsonValue = {
    number: 123,
    state: "OPEN",
    baseRefName: "main",
    headRefName: "release/1.2.3",
    headRefOid: "def456",
    url: "https://github.com/earendil-works/pi-mono/pull/123",
  };

  test("accepts GitHub PR JSON only when the URL, number, and refs match the release branch", () => {
    assert.deepEqual(verifyReleasePullRequestReferenceJson(releasePr, "release/1.2.3"), {
      ok: true,
      summary: [
        "GitHub PR reference is verified.",
        "number: 123",
        "url: https://github.com/earendil-works/pi-mono/pull/123",
        "baseRefName: main",
        "headRefName: release/1.2.3",
        "headRefOid: def456",
        "state: OPEN",
      ].join("\n"),
      prUrl: "https://github.com/earendil-works/pi-mono/pull/123",
      prNumber: 123,
      headRefOid: "def456",
      state: "OPEN",
    });
  });

  test("rejects GitHub PR JSON for an unrelated branch before merge verification", () => {
    const result = verifyReleasePullRequestReferenceJson(
      { ...releasePr, headRefName: "release/other" },
      "release/1.2.3",
    );

    assert.equal(result.ok, false);
    assert.match(result.summary, /headRefName was release\/other, expected release\/1\.2\.3/u);
  });
});

describe("publish-release GitHub merge verification", () => {
  const mergedPr: JsonValue = {
    state: "MERGED",
    mergedAt: "2026-06-12T08:00:00Z",
    mergeCommit: { oid: "abc123" },
    baseRefName: "main",
    headRefName: "release/1.2.3",
    headRefOid: "def456",
    url: "https://github.com/earendil-works/pi-mono/pull/123",
  };

  test("accepts GitHub PR JSON only when merged with matching refs and merge commit", () => {
    assert.deepEqual(verifyPullRequestMergedJson(mergedPr, "release/1.2.3"), {
      ok: true,
      summary: [
        "GitHub PR is verified as merged.",
        "state: MERGED",
        "mergedAt: 2026-06-12T08:00:00Z",
        "mergeCommit.oid: abc123",
        "baseRefName: main",
        "headRefName: release/1.2.3",
        "url: https://github.com/earendil-works/pi-mono/pull/123",
      ].join("\n"),
      mergeCommitOid: "abc123",
      prUrl: "https://github.com/earendil-works/pi-mono/pull/123",
    });
  });

  test("rejects unmerged or mismatched GitHub PR JSON", () => {
    const result = verifyPullRequestMergedJson({ ...mergedPr, state: "OPEN", headRefName: "release/other" }, "release/1.2.3");

    assert.equal(result.ok, false);
    assert.match(result.summary, /state was OPEN, expected MERGED/u);
    assert.match(result.summary, /headRefName was release\/other, expected release\/1\.2\.3/u);
  });
});
