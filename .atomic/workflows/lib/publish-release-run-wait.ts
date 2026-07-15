import {
  commandSummary,
  parseJsonCommand,
  runCommand as defaultRunCommand,
  selectPublishWorkflowRunJson,
  verifyPublishWorkflowRunJson,
  type CommandResult,
  type JsonValue,
  type PublishWorkflowRunVerification,
} from "./publish-release.js";
import { defaultSleep } from "./publish-release-helpers.js";

type RunCommand = (args: readonly string[]) => CommandResult;
type Sleep = (durationMs: number) => Promise<void>;

type WaitOptions = {
  readonly workflowFile: string;
  readonly expectedHeadBranch: string;
  readonly expectedRunId?: number;
  readonly runCommand?: RunCommand;
  readonly sleep?: Sleep;
  readonly listAttempts?: number;
  readonly viewAttempts?: number;
  readonly pollIntervalMs?: number;
};

type RunIdentity =
  | {
      readonly ok: true;
      readonly runId: number;
      readonly runUrl?: string;
      readonly status: string;
      readonly conclusion?: string;
      readonly headSha?: string;
    }
  | {
      readonly ok: false;
      readonly summary: string;
      readonly runId?: number;
      readonly runUrl?: string;
    };

type JsonObject = { readonly [key: string]: JsonValue };

const runJsonFields = "databaseId,status,conclusion,url,headBranch,event,workflowName,displayTitle,createdAt,headSha";
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

function nullableStringField(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function verifyRunIdentityJson(
  value: JsonValue,
  expectedRunId: number,
  expectedHeadBranch: string,
): RunIdentity {
  if (!isJsonObject(value)) return { ok: false, summary: "GitHub Actions run response was not a JSON object." };

  const runId = positiveIntegerField(value, "databaseId");
  const event = stringField(value, "event");
  const status = stringField(value, "status");
  const conclusion = nullableStringField(value, "conclusion");
  const runUrl = stringField(value, "url");
  const headSha = stringField(value, "headSha");
  const displayTitle = stringField(value, "displayTitle");
  const headBranch = stringField(value, "headBranch");
  const workflowName = stringField(value, "workflowName");
  const failures: string[] = [];

  if (runId === undefined) failures.push("databaseId was missing or invalid");
  if (runId !== undefined && runId !== expectedRunId) failures.push(`databaseId was ${runId}, expected ${expectedRunId}`);
  if (displayTitle !== `Publish ${expectedHeadBranch}`) failures.push(`displayTitle was ${displayTitle ?? "missing"}, expected Publish ${expectedHeadBranch}`);
  if (event !== "workflow_dispatch") failures.push(`event was ${event ?? "missing"}, expected workflow_dispatch`);
  if (headBranch !== "main") failures.push(`headBranch was ${headBranch ?? "missing"}, expected main`);
  if (workflowName !== "Publish") failures.push(`workflowName was ${workflowName ?? "missing"}, expected Publish`);
  if (status === undefined) failures.push("status was missing");

  if (failures.length > 0 || runId === undefined || status === undefined) {
    return {
      ok: false,
      summary: ["GitHub Actions publish run identity is not verified.", ...failures.map((failure) => `- ${failure}`)].join("\n"),
      runId,
      runUrl,
    };
  }

  return { ok: true, runId, runUrl, status, conclusion, headSha };
}

function buildRunListCommand(workflowFile: string): readonly string[] {
  return [
    "gh",
    "run",
    "list",
    "--workflow",
    workflowFile,
    "--event",
    "workflow_dispatch",
    "--json",
    runJsonFields,
    "--limit",
    "50",
  ];
}

function buildRunViewCommand(runId: number): readonly string[] {
  return ["gh", "run", "view", String(runId), "--json", runJsonFields];
}

function buildRunJobsCommand(runId: number): readonly string[] {
  return ["gh", "run", "view", String(runId), "--json", "jobs"];
}

function releaseIntegrityJobId(value: JsonValue): number | undefined {
  if (!isJsonObject(value) || !Array.isArray(value.jobs)) return undefined;
  const matches = value.jobs.filter((job) => isJsonObject(job)
    && stringField(job, "name") === "Verify release integrity"
    && stringField(job, "status") === "completed"
    && stringField(job, "conclusion") === "success");
  if (matches.length !== 1 || !isJsonObject(matches[0])) return undefined;
  return positiveIntegerField(matches[0], "databaseId");
}

function buildIntegrityLogCommand(runId: number, jobId: number): readonly string[] {
  return ["gh", "run", "view", String(runId), "--job", String(jobId), "--log"];
}

function verifyIntegrityLog(log: CommandResult, expectedReleaseSha: string): string | undefined {
  if (log.exitCode !== 0) return "Protected release-integrity job log command failed.";
  const matches = [...log.stdout.matchAll(/Release integrity verified: ([0-9a-f]{40}) is deterministic output/gu)];
  const resolved = new Set(matches.map((match) => match[1]));
  if (resolved.size !== 1 || !resolved.has(expectedReleaseSha)) {
    return `Protected release-integrity evidence did not bind the run to expected release SHA ${expectedReleaseSha}.`;
  }
  return undefined;
}

export async function waitForWorkflowRunSucceeded(
  expectedHeadSha: string,
  options: WaitOptions,
): Promise<PublishWorkflowRunVerification> {
  const execute = options.runCommand ?? defaultRunCommand;
  const sleep = options.sleep ?? defaultSleep;
  const listAttempts = options.listAttempts ?? 6;
  const viewAttempts = options.viewAttempts ?? 120;
  const pollIntervalMs = options.pollIntervalMs ?? 10_000;
  let runList: CommandResult | undefined;
  let selectedRun: ReturnType<typeof selectPublishWorkflowRunJson> | undefined;

  if (options.expectedRunId !== undefined) {
    selectedRun = {
      ok: true,
      summary: `GitHub Actions publish run ${options.expectedRunId} was pinned by exhaustive reconciliation.`,
      runId: options.expectedRunId,
      status: "pinned",
    };
  } else {
    for (let attempt = 1; attempt <= listAttempts; attempt += 1) {
      runList = execute(buildRunListCommand(options.workflowFile));
      if (runList.exitCode !== 0) {
        return { ok: false, summary: ["GitHub Actions publish run lookup command failed.", commandSummary(runList)].join("\n\n") };
      }

      const parsedList = parseJsonCommand(runList, "GitHub Actions publish run lookup returned invalid JSON.");
      if (!parsedList.ok) return { ok: false, summary: parsedList.summary };

      selectedRun = selectPublishWorkflowRunJson(parsedList.value, options.expectedHeadBranch);
      if (selectedRun.ok) break;
      if (attempt < listAttempts) await sleep(pollIntervalMs);
    }
  }

  if (selectedRun === undefined || !selectedRun.ok) {
    return {
      ok: false,
      summary: [selectedRun?.summary ?? "GitHub Actions publish run lookup did not execute.", runList === undefined ? undefined : commandSummary(runList)]
        .filter((line): line is string => line !== undefined)
        .join("\n\n"),
    };
  }
  const lookupSummary = runList === undefined
    ? selectedRun.summary
    : commandSummary(runList);

  let lastRunView: CommandResult | undefined;
  let lastPendingSummary = selectedRun.summary;

  for (let attempt = 1; attempt <= viewAttempts; attempt += 1) {
    lastRunView = execute(buildRunViewCommand(selectedRun.runId));
    if (lastRunView.exitCode !== 0) {
      if (attempt < viewAttempts) {
        await sleep(pollIntervalMs);
        continue;
      }
      return {
        ok: false,
        runId: selectedRun.runId,
        runUrl: selectedRun.runUrl,
        summary: ["GitHub Actions publish run verification command failed.", commandSummary(lastRunView)].join("\n\n"),
      };
    }

    const parsedView = parseJsonCommand(lastRunView, "GitHub Actions publish run verification returned invalid JSON.");
    if (!parsedView.ok) return { ok: false, runId: selectedRun.runId, runUrl: selectedRun.runUrl, summary: parsedView.summary };

    const identity = verifyRunIdentityJson(parsedView.value, selectedRun.runId, options.expectedHeadBranch);
    if (!identity.ok) {
      return {
        ok: false,
        runId: identity.runId ?? selectedRun.runId,
        runUrl: identity.runUrl ?? selectedRun.runUrl,
        summary: [identity.summary, lookupSummary, commandSummary(lastRunView)].join("\n\n"),
      };
    }

    if (identity.status !== "completed") {
      lastPendingSummary = [
        "GitHub Actions publish run is still running; continuing to poll.",
        `databaseId: ${identity.runId}`,
        `headBranch: ${options.expectedHeadBranch}`,
        `status: ${identity.status}`,
        identity.conclusion === undefined ? undefined : `conclusion: ${identity.conclusion}`,
        identity.headSha === undefined ? undefined : `headSha: ${identity.headSha}`,
        identity.runUrl === undefined ? undefined : `url: ${identity.runUrl}`,
      ].filter((line): line is string => line !== undefined).join("\n");
      if (attempt < viewAttempts) {
        await sleep(pollIntervalMs);
        continue;
      }
      break;
    }

    const publishVerification = verifyPublishWorkflowRunJson(parsedView.value, options.expectedHeadBranch);
    if (!publishVerification.ok) {
      return {
        ok: false,
        runId: publishVerification.runId ?? selectedRun.runId,
        runUrl: publishVerification.runUrl ?? selectedRun.runUrl,
        summary: [publishVerification.summary, lookupSummary, commandSummary(lastRunView)].join("\n\n"),
      };
    }

    const runJobs = execute(buildRunJobsCommand(selectedRun.runId));
    if (runJobs.exitCode !== 0) {
      return { ok: false, runId: selectedRun.runId, runUrl: selectedRun.runUrl, summary: ["GitHub Actions job lookup failed.", commandSummary(runJobs)].join("\n\n") };
    }
    const parsedJobs = parseJsonCommand(runJobs, "GitHub Actions job lookup returned invalid JSON.");
    if (!parsedJobs.ok) return { ok: false, runId: selectedRun.runId, runUrl: selectedRun.runUrl, summary: parsedJobs.summary };
    const integrityJobId = releaseIntegrityJobId(parsedJobs.value);
    if (integrityJobId === undefined) {
      return { ok: false, runId: selectedRun.runId, runUrl: selectedRun.runUrl, summary: ["Successful protected release-integrity job was not uniquely identified.", commandSummary(runJobs)].join("\n\n") };
    }
    const integrityLog = execute(buildIntegrityLogCommand(selectedRun.runId, integrityJobId));
    const integrityFailure = verifyIntegrityLog(integrityLog, expectedHeadSha);
    if (integrityFailure !== undefined) {
      return { ok: false, runId: selectedRun.runId, runUrl: selectedRun.runUrl, summary: [integrityFailure, commandSummary(integrityLog)].join("\n\n") };
    }

    return {
      ok: true,
      runId: publishVerification.runId,
      runUrl: publishVerification.runUrl,
      status: publishVerification.status,
      conclusion: publishVerification.conclusion,
      headSha: publishVerification.headSha,
      summary: [publishVerification.summary, lookupSummary, commandSummary(lastRunView), commandSummary(runJobs), commandSummary(integrityLog)].join("\n\n"),
    };
  }

  return {
    ok: false,
    runId: selectedRun.runId,
    runUrl: selectedRun.runUrl,
    pending: true,
    summary: [
      "GitHub Actions publish run did not reach a terminal status before the polling timeout.",
      `attempts: ${viewAttempts}`,
      `pollIntervalMs: ${pollIntervalMs}`,
      lastPendingSummary,
      lookupSummary,
      lastRunView === undefined ? undefined : commandSummary(lastRunView),
    ].filter((line): line is string => line !== undefined).join("\n\n"),
  };
}
