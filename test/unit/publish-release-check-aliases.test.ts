import { test } from "bun:test";
import assert from "node:assert/strict";
import { verifyPullRequestChecksForHeadJson } from "../../.atomic/workflows/lib/publish-release-pr.js";
import type { JsonValue } from "../../.atomic/workflows/lib/publish-release.js";

test("duplicate required-check aliases reuse one exact passing rollup result", () => {
  const required: JsonValue = {
    name: "Greptile Review",
    workflow: "",
    link: "https://greptile.com/review/123",
    bucket: "pass",
    state: "SUCCESS",
  };
  const pullRequest: JsonValue = {
    statusCheckRollup: [{
      __typename: "CheckRun",
      name: "Greptile Review",
      workflowName: "",
      detailsUrl: "https://greptile.com/review/123",
      status: "COMPLETED",
      conclusion: "SUCCESS",
    }],
  };

  const result = verifyPullRequestChecksForHeadJson([required, required], pullRequest);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.checkCount, 2);
});
