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

type RunCommand = (args: readonly string[]) => CommandResult;
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

function releaseIntegrityJobId(value: JsonValue): number | undefined {
  if (!isJsonObject(value) || !Array.isArray(value.jobs)) return undefined;
  const matches = value.jobs.filter((job) => isJsonObject(job)
    && stringField(job, "name") === "Verify release integrity"
    && stringField(job, "status") === "completed"
    && stringField(job, "conclusion") === "success");
  if (matches.length !== 1 || !isJsonObject(matches[0])) return undefined;
  return positiveIntegerField(matches[0], "databaseId");
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

export async function verifyPublishRunSucceeded(
  releaseTag: string,
  expectedReleaseSha: string,
  execute: RunCommand = defaultRunCommand,
): Promise<PublishWorkflowRunVerification> {
  const runList = execute([
    "gh", "run", "list", "--workflow", "publish.yml", "--event", "create",
    "--json", runJsonFields, "--limit", "50",
  ]);
  if (runList.exitCode !== 0) {
    return { ok: false, summary: ["GitHub Actions publish run lookup command failed.", commandSummary(runList)].join("\n\n") };
  }

  const parsedList = parseJsonCommand(runList, "GitHub Actions publish run lookup returned invalid JSON.");
  if (!parsedList.ok) return { ok: false, summary: parsedList.summary };
  const selected = selectPublishWorkflowRunJson(parsedList.value, releaseTag);
  if (!selected.ok) {
    return {
      ok: false,
      pending: !selected.summary.startsWith("GitHub Actions publish run is not selectable."),
      summary: [
        selected.summary,
        "No polling was performed. Resume the release workflow after GitHub reports the event-driven publish run.",
        commandSummary(runList),
      ].join("\n\n"),
    };
  }

  const runView = execute(["gh", "run", "view", String(selected.runId), "--json", runJsonFields]);
  if (runView.exitCode !== 0) {
    return { ok: false, runId: selected.runId, runUrl: selected.runUrl, summary: ["GitHub Actions publish run verification command failed.", commandSummary(runView)].join("\n\n") };
  }
  const parsedView = parseJsonCommand(runView, "GitHub Actions publish run verification returned invalid JSON.");
  if (!parsedView.ok) return { ok: false, runId: selected.runId, runUrl: selected.runUrl, summary: parsedView.summary };
  const viewed = selectPublishWorkflowRunJson([parsedView.value], releaseTag);
  if (!viewed.ok) {
    return { ok: false, runId: selected.runId, runUrl: selected.runUrl, summary: [viewed.summary, commandSummary(runView)].join("\n\n") };
  }
  if (viewed.status !== "completed") {
    return {
      ok: false,
      pending: true,
      runId: viewed.runId,
      runUrl: viewed.runUrl,
      summary: [
        "GitHub Actions publish run is still active. No polling was performed; resume after it reaches a terminal state.",
        viewed.summary,
        commandSummary(runView),
      ].join("\n\n"),
    };
  }

  const verified = verifyPublishWorkflowRunJson(parsedView.value, releaseTag);
  if (!verified.ok) {
    return { ...verified, summary: [verified.summary, commandSummary(runView)].join("\n\n") };
  }

  const runJobs = execute(["gh", "run", "view", String(viewed.runId), "--json", "jobs"]);
  if (runJobs.exitCode !== 0) {
    return { ok: false, runId: viewed.runId, runUrl: viewed.runUrl, summary: ["GitHub Actions job lookup failed.", commandSummary(runJobs)].join("\n\n") };
  }
  const parsedJobs = parseJsonCommand(runJobs, "GitHub Actions job lookup returned invalid JSON.");
  if (!parsedJobs.ok) return { ok: false, runId: viewed.runId, runUrl: viewed.runUrl, summary: parsedJobs.summary };
  const integrityJobId = releaseIntegrityJobId(parsedJobs.value);
  if (integrityJobId === undefined) {
    return { ok: false, runId: viewed.runId, runUrl: viewed.runUrl, summary: ["Successful protected release-integrity job was not uniquely identified.", commandSummary(runJobs)].join("\n\n") };
  }

  const integrityLog = execute(["gh", "run", "view", String(viewed.runId), "--job", String(integrityJobId), "--log"]);
  const integrityFailure = verifyIntegrityLog(integrityLog, expectedReleaseSha);
  if (integrityFailure !== undefined) {
    return { ok: false, runId: viewed.runId, runUrl: viewed.runUrl, summary: [integrityFailure, commandSummary(integrityLog)].join("\n\n") };
  }

  return {
    ...verified,
    summary: [verified.summary, commandSummary(runList), commandSummary(runView), commandSummary(runJobs), commandSummary(integrityLog)].join("\n\n"),
  };
}
