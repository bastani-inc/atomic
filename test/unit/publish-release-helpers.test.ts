import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  prereleaseVersionPattern,
  releaseVersionPattern,
  validateReleaseRequest,
  verifyPullRequestChecksJson,
  verifyPullRequestMergedJson,
  verifyReleasePullRequestReferenceJson,
  type CommandResult,
  type JsonValue,
} from "../../.atomic/workflows/lib/publish-release.js";
import { verifyReleasePrChecksPassed } from "../../.atomic/workflows/lib/publish-release-gates.js";


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
  const headOid = "dddddddddddddddddddddddddddddddddddddddd";
  const mergeOid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const prUrl = "https://github.com/earendil-works/pi-mono/pull/123";
  const mergedPr: JsonValue = {
    number: 123,
    state: "MERGED",
    mergedAt: "2026-06-12T08:00:00Z",
    mergeCommit: { oid: mergeOid },
    baseRefName: "main",
    headRefName: "release/1.2.3",
    headRefOid: headOid,
    url: prUrl,
  };

  test("accepts GitHub PR JSON only when merged with matching identity, refs, and merge evidence", () => {
    assert.deepEqual(verifyPullRequestMergedJson(
      mergedPr,
      "release/1.2.3",
      "main",
      headOid,
      { prUrl, prNumber: 123 },
    ), {
      ok: true,
      summary: [
        "GitHub PR is verified as merged.",
        "state: MERGED",
        "mergedAt: 2026-06-12T08:00:00Z",
        `mergeCommit.oid: ${mergeOid}`,
        "baseRefName: main",
        "headRefName: release/1.2.3",
        `headRefOid: ${headOid}`,
        `url: ${prUrl}`,
        "number: 123",
      ].join("\n"),
      mergeCommitOid: mergeOid,
      prUrl,
    });
  });

  test("rejects unmerged or mismatched GitHub PR JSON", () => {
    const result = verifyPullRequestMergedJson(
      { ...mergedPr, state: "OPEN", headRefName: "release/other" },
      "release/1.2.3",
      "main",
      headOid,
      { prUrl, prNumber: 123 },
    );

    assert.equal(result.ok, false);
    assert.match(result.summary, /state was OPEN, expected MERGED/u);
    assert.match(result.summary, /headRefName was release\/other, expected release\/1\.2\.3/u);
  });
});

describe("publish-release GitHub PR checks verification", () => {
  test("accepts only non-empty required check lists where every check is passing", () => {
    assert.deepEqual(verifyPullRequestChecksJson([
      { name: "typecheck", bucket: "pass", state: "SUCCESS" },
      { name: "unit", state: "SUCCESS" },
    ]), {
      ok: true,
      summary: [
        "GitHub PR required checks are verified as passing.",
        "checkCount: 2",
      ].join("\n"),
      checkCount: 2,
    });
  });

  test("distinguishes failing checks from pending checks", () => {
    assert.equal(verifyPullRequestChecksJson([]).ok, false);
    const failed = verifyPullRequestChecksJson([
      { name: "typecheck", bucket: "fail", state: "FAILURE", link: "https://example.test/check" },
    ]);
    assert.equal(failed.ok, false);
    assert.equal(failed.pending, undefined);
    assert.match(failed.summary, /typecheck bucket=fail state=FAILURE link=https:\/\/example\.test\/check/u);

    const pending = verifyPullRequestChecksJson([
      { name: "unit", bucket: "pending", state: "PENDING" },
    ]);
    assert.equal(pending.ok, false);
    assert.equal(pending.pending, true);
    assert.match(pending.summary, /unit bucket=pending state=PENDING/u);
  });

  test("polls pending PR checks until they pass", async () => {
    const release = validateReleaseRequest("release", "1.2.3");
    const prReference = {
      ok: true as const,
      summary: "GitHub PR reference is verified.",
      prUrl: "https://github.com/earendil-works/pi-mono/pull/123",
      prNumber: 123,
      headRefOid: "def456",
      state: "OPEN" as const,
    };
    const prView = {
      number: 123,
      state: "OPEN",
      baseRefName: "main",
      headRefName: "release/1.2.3",
      headRefOid: "def456",
      url: prReference.prUrl,
      statusCheckRollup: [{ name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
    };
    const responses: CommandResult[] = [
      { command: "gh pr view", exitCode: 0, stdout: JSON.stringify(prView), stderr: "" },
      { command: "gh pr checks", exitCode: 8, stdout: JSON.stringify([{ name: "unit", bucket: "pending", state: "PENDING" }]), stderr: "" },
      { command: "gh pr view", exitCode: 0, stdout: JSON.stringify(prView), stderr: "" },
      { command: "gh pr checks", exitCode: 0, stdout: JSON.stringify([{ name: "unit", bucket: "pass", state: "SUCCESS" }]), stderr: "" },
      { command: "gh pr view", exitCode: 0, stdout: JSON.stringify(prView), stderr: "" },
    ];
    const sleeps: number[] = [];

    const result = await verifyReleasePrChecksPassed(release, prReference, "main", {
      attempts: 2,
      pollIntervalMs: 25,
      runCommand: (args) => {
        const response = responses.shift();
        if (response === undefined) throw new Error(`unexpected command: ${args.join(" ")}`);
        return { ...response, command: args.join(" ") };
      },
      sleep: (durationMs) => {
        sleeps.push(durationMs);
        return Promise.resolve();
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(sleeps, [25]);
    assert.equal(responses.length, 0);
  });

  test("marks PR checks as pending when polling times out", async () => {
    const release = validateReleaseRequest("release", "1.2.3");
    const prReference = {
      ok: true as const,
      summary: "GitHub PR reference is verified.",
      prUrl: "https://github.com/earendil-works/pi-mono/pull/123",
      prNumber: 123,
      headRefOid: "def456",
      state: "OPEN" as const,
    };
    const prView = {
      number: 123,
      state: "OPEN",
      baseRefName: "main",
      headRefName: "release/1.2.3",
      headRefOid: "def456",
      url: prReference.prUrl,
      statusCheckRollup: [{ name: "unit", status: "IN_PROGRESS", conclusion: null }],
    };
    const result = await verifyReleasePrChecksPassed(release, prReference, "main", {
      attempts: 1,
      pollIntervalMs: 25,
      runCommand: (args) => ({
        command: args.join(" "),
        exitCode: args.includes("checks") ? 8 : 0,
        stdout: JSON.stringify(args.includes("checks") ? [{ name: "unit", bucket: "pending", state: "PENDING" }] : prView),
        stderr: "",
      }),
      sleep: () => Promise.resolve(),
    });

    assert.equal(result.ok, false);
    assert.equal(result.pending, true);
    assert.match(result.summary, /did not finish before the polling timeout/u);
  });

  test("publish-release polling helpers do not reference Bun globals", () => {
    const helpers = [
      ".atomic/workflows/lib/publish-release-gates.ts",
      ".atomic/workflows/lib/publish-release-run-wait.ts",
    ];
    for (const helper of helpers) {
      assert.doesNotMatch(readFileSync(helper, "utf8"), /\bBun\./u, helper);
    }
  });

  test("does not treat completed check status as passing without a pass bucket", () => {
    const result = verifyPullRequestChecksJson([
      { name: "typecheck", state: "COMPLETED" },
    ]);

    assert.equal(result.ok, false);
    assert.match(result.summary, /typecheck bucket=missing state=COMPLETED/u);
  });
});
