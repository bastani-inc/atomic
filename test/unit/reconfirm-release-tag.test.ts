import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  assertReleaseTagUnmoved,
  reconfirmReleaseTag,
  resolveRemoteTagSha,
  type GitResult,
  type RunGit,
} from "../../scripts/reconfirm-release-tag.js";

const verifiedSha = "0123456789abcdef0123456789abcdef01234567";
const movedSha = "89abcdef0123456789abcdef0123456789abcdef";
const tag = "0.9.10-alpha.1";

function stubGit(results: readonly GitResult[]): { runGit: RunGit; calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;
  const runGit: RunGit = (args) => {
    calls.push([...args]);
    const result = results[index] ?? results[results.length - 1];
    index += 1;
    return result ?? { exitCode: 1, stdout: "", stderr: "no stub" };
  };
  return { runGit, calls };
}

test("resolveRemoteTagSha queries the exact refs/tags ref on origin and returns its SHA", () => {
  const { runGit, calls } = stubGit([
    { exitCode: 0, stdout: `${verifiedSha}\trefs/tags/${tag}\n`, stderr: "" },
  ]);
  assert.equal(resolveRemoteTagSha(tag, runGit), verifiedSha);
  assert.deepEqual(calls[0], ["ls-remote", "--exit-code", "--refs", "origin", `refs/tags/${tag}`]);
});

test("resolveRemoteTagSha throws when the tag was deleted (non-zero ls-remote)", () => {
  const { runGit } = stubGit([{ exitCode: 2, stdout: "", stderr: "" }]);
  assert.throws(
    () => resolveRemoteTagSha(tag, runGit),
    /Release tag 0\.9\.10-alpha\.1 is no longer resolvable on origin[\s\S]*refusing irreversible publication/u,
  );
});

test("resolveRemoteTagSha throws on an ambiguous or malformed SHA", () => {
  const { runGit } = stubGit([{ exitCode: 0, stdout: "not-a-sha\trefs/tags/x\n", stderr: "" }]);
  assert.throws(() => resolveRemoteTagSha(tag, runGit), /Could not resolve release tag/u);
});

test("assertReleaseTagUnmoved passes only on an exact SHA match", () => {
  assert.equal(assertReleaseTagUnmoved(tag, verifiedSha, verifiedSha), undefined);
});

test("assertReleaseTagUnmoved fails closed when the remote tag moved", () => {
  assert.throws(
    () => assertReleaseTagUnmoved(tag, verifiedSha, movedSha),
    /moved from verified 0123456789abcdef0123456789abcdef01234567 to 89abcdef0123456789abcdef0123456789abcdef[\s\S]*refusing irreversible publication/u,
  );
});

test("assertReleaseTagUnmoved rejects a malformed verified SHA", () => {
  assert.throws(() => assertReleaseTagUnmoved(tag, "bogus", verifiedSha), /Invalid verified release SHA/u);
});

test("reconfirmReleaseTag binds the freshly resolved remote tag to the verified SHA", () => {
  const unmoved = stubGit([{ exitCode: 0, stdout: `${verifiedSha}\trefs/tags/${tag}\n`, stderr: "" }]);
  assert.equal(reconfirmReleaseTag(tag, verifiedSha, unmoved.runGit), verifiedSha);

  const moved = stubGit([{ exitCode: 0, stdout: `${movedSha}\trefs/tags/${tag}\n`, stderr: "" }]);
  assert.throws(() => reconfirmReleaseTag(tag, verifiedSha, moved.runGit), /moved from verified/u);
});
