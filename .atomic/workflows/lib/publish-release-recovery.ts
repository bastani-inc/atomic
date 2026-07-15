import {
  commandSummary,
  parseJsonCommand,
  runCommand,
  selectPublishWorkflowRunJson,
  type CommandResult,
  type ValidatedRelease,
  type JsonValue,
} from "./publish-release.js";
import { defaultSleep } from "./publish-release-helpers.js";

type Execute = (args: readonly string[]) => CommandResult;
type DispatchLookupOptions = {
  readonly execute?: Execute;
  readonly attempts?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (durationMs: number) => Promise<void>;
};

export type ReleaseTagRecovery =
  | {
      readonly ok: true;
      readonly state: "absent" | "local-only" | "remote-only" | "published";
      readonly summary: string;
      readonly tagTargetOid?: string;
    }
  | { readonly ok: false; readonly summary: string };

export type PublishDispatchRecovery =
  | {
      readonly ok: true;
      readonly found: true;
      readonly runId: number;
      readonly runUrl?: string;
      readonly summary: string;
    }
  | { readonly ok: true; readonly found: false; readonly summary: string }
  | { readonly ok: false; readonly summary: string };

export function inspectReleaseTagRecovery(
  release: ValidatedRelease,
  currentBaseOid: string,
  requiredMergeOid: string,
  execute: Execute = runCommand,
): ReleaseTagRecovery {
  const localTag = execute(["git", "rev-parse", `${release.version}^{commit}`]);
  const remoteTag = execute(["git", "ls-remote", "--tags", "origin", `refs/tags/${release.version}`]);
  if (remoteTag.exitCode !== 0) {
    return { ok: false, summary: ["Remote release tag lookup failed.", commandSummary(remoteTag)].join("\n\n") };
  }

  const localOid = localTag.exitCode === 0 ? localTag.stdout : "";
  const remoteOid = remoteTag.stdout.split(/\s+/u)[0] ?? "";
  const commands = [commandSummary(localTag), commandSummary(remoteTag)];
  if (localOid.length === 0 && remoteOid.length === 0) {
    return { ok: true, state: "absent", summary: ["Release tag is absent locally and on origin.", ...commands].join("\n\n") };
  }
  if (localOid.length === 0) {
    return {
      ok: true,
      state: "remote-only",
      summary: ["Release tag exists only on origin and must be fetched without force before verification.", `remoteTagTargetOid: ${remoteOid}`, ...commands].join("\n\n"),
    };
  }

  const tagParent = execute(["git", "rev-parse", `${release.version}^{commit}^`]);
  const taggedManifest = execute(["git", "show", `${release.version}:packages/coding-agent/package.json`]);
  const integratedParent = execute(["git", "merge-base", "--is-ancestor", tagParent.stdout, currentBaseOid]);
  const containsMerge = execute(["git", "merge-base", "--is-ancestor", requiredMergeOid, tagParent.stdout]);
  let stampedVersion: string | undefined;
  if (taggedManifest.exitCode === 0) {
    try {
      stampedVersion = (JSON.parse(taggedManifest.stdout) as { readonly version?: string }).version;
    } catch {
      stampedVersion = undefined;
    }
  }
  const validationCommands = [
    ...commands,
    commandSummary(tagParent),
    commandSummary(taggedManifest),
    commandSummary(integratedParent),
    commandSummary(containsMerge),
  ];
  const failures: string[] = [];
  if (tagParent.exitCode !== 0 || tagParent.stdout.length === 0) {
    failures.push("release commit parent could not be resolved");
  } else if (integratedParent.exitCode !== 0) {
    failures.push(`release commit parent ${tagParent.stdout} is not integrated into current base ${currentBaseOid}`);
  }
  if (containsMerge.exitCode !== 0) {
    failures.push(`verified merge commit ${requiredMergeOid} is not an ancestor of release parent ${tagParent.stdout || "missing"}`);
  }
  if (stampedVersion !== release.version) {
    failures.push(`tagged @bastani/atomic version was ${stampedVersion ?? "unparseable"}, expected ${release.version}`);
  }
  if (remoteOid.length > 0 && remoteOid !== localOid) {
    failures.push(`remote tag target was ${remoteOid}, expected local release commit ${localOid}`);
  }
  if (failures.length > 0) {
    return {
      ok: false,
      summary: ["Existing release tag conflicts with deterministic release evidence.", ...failures.map((failure) => `- ${failure}`), ...validationCommands].join("\n\n"),
    };
  }

  const state = remoteOid.length === 0 ? "local-only" : "published";
  return {
    ok: true,
    state,
    tagTargetOid: localOid,
    summary: [
      state === "published"
        ? "Existing local and remote release tags match deterministic release evidence."
        : "Existing local release tag matches deterministic release evidence and must be pushed without force.",
      `tagTargetOid: ${localOid}`,
      ...validationCommands,
    ].join("\n\n"),
  };
}

const restPageSize = 100;

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePublishRunPages(value: JsonValue): readonly JsonValue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized: JsonValue[] = [];
  for (const page of value) {
    if (!isJsonObject(page) || !Array.isArray(page.workflow_runs)) return undefined;
    for (const run of page.workflow_runs) {
      if (!isJsonObject(run)) {
        normalized.push(run);
        continue;
      }
      normalized.push({
        databaseId: run.id ?? null,
        workflowName: run.path === ".github/workflows/publish.yml" ? "Publish" : null,
        headBranch: run.head_branch ?? null,
        event: run.event ?? null,
        displayTitle: run.display_title ?? null,
        status: run.status ?? null,
        conclusion: run.conclusion ?? null,
        headSha: run.head_sha ?? null,
        url: run.html_url ?? null,
      });
    }
  }
  return normalized;
}

function publishRunHistorySummary(result: CommandResult, runCount: number): string {
  return [`$ ${result.command}`, `exitCode: ${result.exitCode}`, `runCount: ${runCount}`].join("\n");
}

export async function findExistingPublishDispatch(
  release: ValidatedRelease,
  options: DispatchLookupOptions = {},
): Promise<PublishDispatchRecovery> {
  const execute = options.execute ?? runCommand;
  const attempts = Math.max(1, options.attempts ?? 1);
  const pollIntervalMs = options.pollIntervalMs ?? 10_000;
  const sleep = options.sleep ?? defaultSleep;
  let lastSummary = "GitHub Actions publish run lookup did not execute.";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const runList = execute([
      "gh", "api", "--method", "GET", "--paginate", "--slurp",
      `repos/{owner}/{repo}/actions/workflows/publish.yml/runs?per_page=${restPageSize}`,
    ]);
    if (runList.exitCode !== 0) {
      return { ok: false, summary: ["GitHub Actions publish run history command failed.", commandSummary(runList)].join("\n\n") };
    }
    const parsed = parseJsonCommand(runList, "GitHub Actions publish run history returned invalid JSON.");
    if (!parsed.ok) return parsed;
    const normalized = normalizePublishRunPages(parsed.value);
    if (normalized === undefined) {
      return { ok: false, summary: ["GitHub Actions publish run history had an invalid paginated shape.", commandSummary(runList)].join("\n\n") };
    }
    const selected = selectPublishWorkflowRunJson(normalized, release.version);
    if (selected.ok) {
      return {
        ok: true,
        found: true,
        runId: selected.runId,
        runUrl: selected.runUrl,
        summary: [
          "Existing protected publish dispatch will be reused; no duplicate dispatch is needed.",
          selected.summary,
          publishRunHistorySummary(runList, normalized.length),
        ].join("\n\n"),
      };
    }
    if (selected.summary.startsWith("GitHub Actions publish run is not selectable.")) {
      return { ok: false, summary: [selected.summary, commandSummary(runList)].join("\n\n") };
    }
    lastSummary = [selected.summary, publishRunHistorySummary(runList, normalized.length)].join("\n\n");
    if (attempt < attempts) await sleep(pollIntervalMs);
  }

  return {
    ok: true,
    found: false,
    summary: [
      "No existing protected publish dispatch appeared during the reconciliation window.",
      `attempts: ${attempts}`,
      `pollIntervalMs: ${pollIntervalMs}`,
      lastSummary,
    ].join("\n\n"),
  };
}
