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
const tag = "1.2.3-alpha.1";

function stubGit(result: GitResult): { readonly runGit: RunGit; readonly calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runGit: (args) => {
      calls.push([...args]);
      return result;
    },
  };
}

test("reconfirmation resolves the exact remote tag ref", () => {
  const stub = stubGit({ exitCode: 0, stdout: `${verifiedSha}\trefs/tags/${tag}\n`, stderr: "" });
  assert.equal(resolveRemoteTagSha(tag, stub.runGit), verifiedSha);
  assert.deepEqual(stub.calls, [["ls-remote", "--exit-code", "--refs", "origin", `refs/tags/${tag}`]]);
});

test("reconfirmation rejects invalid, missing, malformed, and ambiguous tags", () => {
  const missing = stubGit({ exitCode: 2, stdout: "", stderr: "missing" });
  assert.throws(() => resolveRemoteTagSha(tag, missing.runGit), /not resolvable on origin/u);

  const malformed = stubGit({ exitCode: 0, stdout: `bad\trefs/tags/${tag}\n`, stderr: "" });
  assert.throws(() => resolveRemoteTagSha(tag, malformed.runGit), /one exact commit SHA/u);

  const ambiguous = stubGit({
    exitCode: 0,
    stdout: `${verifiedSha}\trefs/tags/${tag}\n${movedSha}\trefs/tags/${tag}\n`,
    stderr: "",
  });
  assert.throws(() => resolveRemoteTagSha(tag, ambiguous.runGit), /resolved to 2 refs/u);
  assert.throws(() => resolveRemoteTagSha("0.0.0", ambiguous.runGit), /Invalid release tag/u);
});

test("reconfirmation fails closed when the verified SHA is invalid or the tag moved", () => {
  assert.equal(assertReleaseTagUnmoved(tag, verifiedSha, verifiedSha), undefined);
  assert.throws(() => assertReleaseTagUnmoved(tag, "bad", verifiedSha), /Invalid verified release SHA/u);
  assert.throws(() => assertReleaseTagUnmoved(tag, verifiedSha, movedSha), /moved from verified/u);

  const moved = stubGit({ exitCode: 0, stdout: `${movedSha}\trefs/tags/${tag}\n`, stderr: "" });
  assert.throws(() => reconfirmReleaseTag(tag, verifiedSha, moved.runGit), /refusing irreversible publication/u);
});
