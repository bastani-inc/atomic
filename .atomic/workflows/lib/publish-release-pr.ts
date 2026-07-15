import type {
  JsonValue,
  PullRequestChecksVerification,
  PullRequestMergeVerification,
  PullRequestReferenceVerification,
  ReleasePrState,
} from "./publish-release-types.js";

type JsonObject = { readonly [key: string]: JsonValue };
type PullRequestIdentity = { readonly prUrl: string; readonly prNumber: number };

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveIntegerField(object: JsonObject, key: string): number | undefined {
  const value = object[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isReleasePrState(value: string | undefined): value is ReleasePrState {
  return value === "OPEN" || value === "MERGED";
}

function isRfc3339Timestamp(value: string | undefined): value is string {
  if (value === undefined) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u.exec(value);
  if (match === null) return false;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return false;
  const date = new Date(timestamp);
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3])
    && date.getUTCHours() === Number(match[4])
    && date.getUTCMinutes() === Number(match[5])
    && date.getUTCSeconds() === Number(match[6]);
}

export function verifyReleasePullRequestReferenceJson(
  value: JsonValue,
  expectedHeadRefName: string,
  expectedBaseRefName = "main",
  expectedHeadRefOid?: string,
  expectedStates?: ReleasePrState | readonly ReleasePrState[],
  expectedIdentity?: PullRequestIdentity,
): PullRequestReferenceVerification {
  if (!isJsonObject(value)) {
    return { ok: false, summary: "GitHub PR reference response was not a JSON object." };
  }

  const baseRefName = stringField(value, "baseRefName");
  const headRefName = stringField(value, "headRefName");
  const headRefOid = stringField(value, "headRefOid");
  const prUrl = stringField(value, "url");
  const prNumber = positiveIntegerField(value, "number");
  const rawState = stringField(value, "state");
  const state = isReleasePrState(rawState) ? rawState : undefined;
  const failures: string[] = [];

  if (prUrl === undefined) failures.push("url was missing");
  if (prNumber === undefined) failures.push("number was missing or invalid");
  if (headRefOid === undefined) failures.push("headRefOid was missing");
  if (state === undefined) failures.push(`state was ${rawState ?? "missing"}, expected OPEN or MERGED`);
  if (baseRefName !== expectedBaseRefName) failures.push(`baseRefName was ${baseRefName ?? "missing"}, expected ${expectedBaseRefName}`);
  if (headRefName !== expectedHeadRefName) failures.push(`headRefName was ${headRefName ?? "missing"}, expected ${expectedHeadRefName}`);
  if (expectedHeadRefOid !== undefined && headRefOid !== expectedHeadRefOid) {
    failures.push(`headRefOid was ${headRefOid ?? "missing"}, expected ${expectedHeadRefOid}`);
  }
  const allowedStates = typeof expectedStates === "string" ? [expectedStates] : expectedStates;
  if (allowedStates !== undefined && (state === undefined || !allowedStates.includes(state))) {
    failures.push(`state was ${rawState ?? "missing"}, expected ${allowedStates.join(" or ")}`);
  }
  if (expectedIdentity !== undefined && prUrl !== expectedIdentity.prUrl) {
    failures.push(`url was ${prUrl ?? "missing"}, expected captured URL ${expectedIdentity.prUrl}`);
  }
  if (expectedIdentity !== undefined && prNumber !== expectedIdentity.prNumber) {
    failures.push(`number was ${prNumber ?? "missing"}, expected captured number ${expectedIdentity.prNumber}`);
  }

  if (failures.length > 0 || prUrl === undefined || prNumber === undefined || headRefOid === undefined || state === undefined) {
    return {
      ok: false,
      summary: ["GitHub PR reference is not verified.", ...failures.map((failure) => `- ${failure}`)].join("\n"),
      prUrl,
      prNumber,
    };
  }

  return {
    ok: true,
    summary: [
      "GitHub PR reference is verified.",
      `number: ${prNumber}`,
      `url: ${prUrl}`,
      `baseRefName: ${baseRefName}`,
      `headRefName: ${headRefName}`,
      `headRefOid: ${headRefOid}`,
      `state: ${state}`,
    ].join("\n"),
    prUrl,
    prNumber,
    headRefOid,
    state,
  };
}

function rollupCheckName(value: JsonValue): string | undefined {
  if (!isJsonObject(value)) return undefined;
  return stringField(value, "name") ?? stringField(value, "context");
}
function rollupCheckLink(value: JsonValue): string | undefined {
  if (!isJsonObject(value)) return undefined;
  return stringField(value, "detailsUrl") ?? stringField(value, "targetUrl");
}
function rollupCheckWorkflow(value: JsonValue): string | undefined {
  if (!isJsonObject(value)) return undefined;
  return stringField(value, "workflowName");
}

function isRequiredContext(value: JsonValue, name: string, workflow: string | undefined): boolean {
  return rollupCheckName(value) === name
    && (workflow === undefined || rollupCheckWorkflow(value) === workflow);
}

function rollupCheckPassed(value: JsonValue): boolean {
  if (!isJsonObject(value)) return false;
  const conclusion = stringField(value, "conclusion")?.toUpperCase();
  if (conclusion !== undefined) return conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED";
  return stringField(value, "state")?.toUpperCase() === "SUCCESS";
}

export function verifyPullRequestChecksForHeadJson(
  requiredChecks: JsonValue,
  pullRequest: JsonValue,
): PullRequestChecksVerification {
  const requiredVerification = verifyPullRequestChecksJson(requiredChecks);
  if (!requiredVerification.ok) return requiredVerification;
  if (!Array.isArray(requiredChecks) || !isJsonObject(pullRequest)) {
    return { ok: false, summary: "GitHub PR required checks could not be tied to the captured head SHA." };
  }
  const rollup = pullRequest.statusCheckRollup;
  if (!Array.isArray(rollup)) {
    return { ok: false, summary: "GitHub PR statusCheckRollup was missing for the captured head SHA." };
  }

  const available = rollup.map((check, index) => ({ check, index, used: false }));
  const failures: string[] = [];
  for (const [index, required] of requiredChecks.entries()) {
    const name = isJsonObject(required)
      ? stringField(required, "name") ?? stringField(required, "workflow")
      : undefined;
    const link = isJsonObject(required) ? stringField(required, "link") : undefined;
    const workflow = isJsonObject(required) ? stringField(required, "workflow") : undefined;
    if (name === undefined) {
      failures.push(`required check[${index}] had no name`);
      continue;
    }
    const sameContext = available.filter((candidate) => isRequiredContext(candidate.check, name, workflow));
    if (sameContext.some((candidate) => !rollupCheckPassed(candidate.check))) {
      failures.push(`required check ${name} had a pending or failing rerun in the captured head status rollup`);
      continue;
    }
    const match = available.find((candidate) => !candidate.used
      && isRequiredContext(candidate.check, name, workflow)
      && (link === undefined || rollupCheckLink(candidate.check) === link)
      && rollupCheckPassed(candidate.check));
    if (match === undefined) failures.push(`required check ${name} was not passing in the captured head status rollup`);
    else match.used = true;
  }

  if (failures.length > 0) {
    return {
      ok: false,
      summary: ["GitHub PR required checks are not verified for the captured head SHA.", ...failures.map((failure) => `- ${failure}`)].join("\n"),
    };
  }
  return {
    ok: true,
    summary: ["GitHub PR required checks are verified for the captured head SHA.", `checkCount: ${requiredVerification.checkCount}`].join("\n"),
    checkCount: requiredVerification.checkCount,
  };
}

export function verifyPullRequestMergedJson(
  value: JsonValue,
  expectedHeadRefName: string,
  expectedBaseRefName: string,
  expectedHeadRefOid: string,
  expectedIdentity: PullRequestIdentity,
): PullRequestMergeVerification {
  if (!isJsonObject(value)) return { ok: false, summary: "GitHub PR response was not a JSON object." };

  const state = stringField(value, "state");
  const mergedAt = stringField(value, "mergedAt");
  const baseRefName = stringField(value, "baseRefName");
  const headRefName = stringField(value, "headRefName");
  const headRefOid = stringField(value, "headRefOid");
  const prUrl = stringField(value, "url");
  const prNumber = positiveIntegerField(value, "number");
  const mergeCommit = value.mergeCommit;
  const mergeCommitOid = isJsonObject(mergeCommit) ? stringField(mergeCommit, "oid") : undefined;
  const failures: string[] = [];

  if (state !== "MERGED") failures.push(`state was ${state ?? "missing"}, expected MERGED`);
  if (!isRfc3339Timestamp(mergedAt)) failures.push("mergedAt was missing or invalid");
  if (mergeCommitOid === undefined || !/^[0-9a-f]{40}$/iu.test(mergeCommitOid)) failures.push("mergeCommit.oid was missing or invalid");
  if (baseRefName !== expectedBaseRefName) failures.push(`baseRefName was ${baseRefName ?? "missing"}, expected ${expectedBaseRefName}`);
  if (headRefName !== expectedHeadRefName) failures.push(`headRefName was ${headRefName ?? "missing"}, expected ${expectedHeadRefName}`);
  if (headRefOid !== expectedHeadRefOid) failures.push(`headRefOid was ${headRefOid ?? "missing"}, expected ${expectedHeadRefOid}`);
  if (prUrl !== expectedIdentity.prUrl) failures.push(`url was ${prUrl ?? "missing"}, expected captured URL ${expectedIdentity.prUrl}`);
  if (prNumber !== expectedIdentity.prNumber) failures.push(`number was ${prNumber ?? "missing"}, expected captured number ${expectedIdentity.prNumber}`);

  if (failures.length > 0 || mergeCommitOid === undefined || prUrl === undefined) {
    return {
      ok: false,
      summary: ["GitHub PR is not verified as merged.", ...failures.map((failure) => `- ${failure}`)].join("\n"),
      prUrl,
    };
  }

  return {
    ok: true,
    summary: [
      "GitHub PR is verified as merged.",
      `state: ${state}`,
      `mergedAt: ${mergedAt}`,
      `mergeCommit.oid: ${mergeCommitOid}`,
      `baseRefName: ${baseRefName}`,
      `headRefName: ${headRefName}`,
      `headRefOid: ${headRefOid}`,
      `url: ${prUrl}`,
      `number: ${prNumber}`,
    ].join("\n"),
    mergeCommitOid,
    prUrl,
  };
}

function checkName(value: JsonValue, index: number): string {
  if (!isJsonObject(value)) return `check[${index}]`;
  return stringField(value, "name") ?? stringField(value, "workflow") ?? `check[${index}]`;
}

function checkPassed(value: JsonObject): boolean {
  const bucket = stringField(value, "bucket")?.toLowerCase();
  if (bucket !== undefined) return bucket === "pass";
  const state = stringField(value, "state")?.toUpperCase();
  return state === "SUCCESS" || state === "PASSING" || state === "PASSED";
}

function checkPending(value: JsonObject): boolean {
  const bucket = stringField(value, "bucket")?.toLowerCase();
  if (bucket !== undefined) return bucket === "pending";
  const state = stringField(value, "state")?.toUpperCase();
  return state === "PENDING" || state === "QUEUED" || state === "IN_PROGRESS" || state === "WAITING" || state === "REQUESTED";
}

export function verifyPullRequestChecksJson(value: JsonValue): PullRequestChecksVerification {
  if (!Array.isArray(value)) return { ok: false, summary: "GitHub PR checks response was not a JSON array." };
  if (value.length === 0) return { ok: false, summary: "GitHub PR checks response contained no required checks." };

  const failures: string[] = [];
  const pending: string[] = [];
  for (const [index, check] of value.entries()) {
    if (!isJsonObject(check)) {
      failures.push(`check[${index}] was not a JSON object`);
      continue;
    }
    if (checkPassed(check)) continue;
    const name = checkName(check, index);
    const bucket = stringField(check, "bucket") ?? "missing";
    const state = stringField(check, "state") ?? "missing";
    const link = stringField(check, "link");
    const line = `${name} bucket=${bucket} state=${state}${link === undefined ? "" : ` link=${link}`}`;
    if (checkPending(check)) pending.push(line);
    else failures.push(line);
  }

  if (failures.length > 0) {
    return { ok: false, summary: ["GitHub PR required checks are not verified as passing.", ...failures.map((failure) => `- ${failure}`)].join("\n") };
  }
  if (pending.length > 0) {
    return { ok: false, pending: true, summary: ["GitHub PR required checks are still pending.", ...pending.map((check) => `- ${check}`)].join("\n") };
  }
  return { ok: true, summary: ["GitHub PR required checks are verified as passing.", `checkCount: ${value.length}`].join("\n"), checkCount: value.length };
}
