import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createGitEnvironment } from "@bastani/atomic";

export type StaleDocTask = {
  id: string;
  title: string;
  owner_docs: string[];
  reason: string;
  source_refs: string[];
  update_instructions: string;
  acceptance_criteria: string[];
};

export type CommandResult = {
  command: string;
  ok: boolean;
  output: string;
};

export type CommandRunner = (command: string, args: string[], cwd?: string) => CommandResult;

export type DocsValidationPhase = "skip_repair" | "repair_then_revalidate";

export type UpdateArtifactStatus = {
  path: string;
  exists: boolean;
  empty: boolean;
};

export type GhPrVerification = {
  ok: boolean;
  summary: string;
  url?: string;
};

export const DEFAULT_RELEASE_DOCS_BASE_BRANCH = "main";

const repoRoot = (): string => process.cwd();

// Sanitize repository-local Git environment variables (GIT_DIR, GIT_WORK_TREE,
// GIT_INDEX_FILE, ...) so subprocesses always target `cwd`. Git honors these
// variables over cwd, so when this lib runs under a hook runner (e.g. prek
// pre-commit/pre-push), inherited values would silently redirect every command
// at the real repository — `git init` even persists `core.worktree` into the
// shared .git/config of the invoking worktree (see git-env.ts).
const runCommand = (command: string, args: string[], cwd = repoRoot()): string =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: createGitEnvironment(),
    maxBuffer: 1024 * 1024 * 20,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

export const runCommandResult: CommandRunner = (command, args, cwd = repoRoot()) => {
  const rendered = [command, ...args].join(" ");
  try {
    const output = runCommand(command, args, cwd);
    return { command: rendered, ok: true, output };
  } catch (error) {
    const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const stdout = String(failure.stdout ?? "");
    const stderr = String(failure.stderr ?? "");
    const message = String(failure.message ?? "");
    return { command: rendered, ok: false, output: [stdout, stderr, message].filter(Boolean).join("\n") };
  }
};

export const runGit = (args: string[], cwd = repoRoot()): string => runCommand("git", args, cwd);

export const sanitizeSegment = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";

export const releaseDocsUpdateTaskKey = (task: Pick<StaleDocTask, "id">, index: number): string =>
  `${String(index + 1).padStart(3, "0")}-${sanitizeSegment(task.id)}`;

const normalizeOwnerDocPath = (path: string): string => {
  let normalized = path.trim().replace(/\\+/g, "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized.replace(/\/+/g, "/");
};

const dedupeStrings = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
};

const dedupeOwnerDocs = (paths: readonly string[]): string[] => {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const path of paths) {
    const normalized = normalizeOwnerDocPath(path);
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
};

export const requireNonBaseBranch = (
  currentBranch: string,
  baseBranch = DEFAULT_RELEASE_DOCS_BASE_BRANCH,
): string => {
  const current = currentBranch.trim();
  const base = baseBranch.trim();

  if (current.length === 0) {
    throw new Error("release-docs requires a non-empty current branch name.");
  }

  if (base.length === 0) {
    throw new Error("release-docs requires a non-empty PR base branch.");
  }

  if (current === base) {
    throw new Error(
      [
        `release-docs refuses to run directly on the PR base branch '${base}'.`,
        "Check out a feature branch before running this workflow.",
      ].join("\n"),
    );
  }

  return current;
};

export const currentBranchName = (cwd = repoRoot()): string => {
  const branch = runGit(["branch", "--show-current"], cwd);
  if (branch.length > 0) {
    return branch;
  }

  const shortSha = runGit(["rev-parse", "--short", "HEAD"], cwd);
  throw new Error(
    [
      "release-docs must run from a local branch, but HEAD is detached.",
      `Current detached commit: ${shortSha}`,
      "Check out or create a branch before running this workflow.",
    ].join("\n"),
  );
};

export const requireResearchDocPath = (path: string | undefined): string => {
  const trimmed = path?.trim() ?? "";
  if (trimmed.length === 0) {
    throw new Error(
      "deep-research-codebase did not return research_doc_path; release-docs cannot continue without a research artifact path.",
    );
  }
  return trimmed;
};

export const extractJsonArray = (text: string): StaleDocTask[] => {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const jsonText = fenced?.[1]?.trim() ?? trimmed;
  let parsed: StaleDocTask[];
  try {
    parsed = JSON.parse(jsonText) as StaleDocTask[];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const excerpt = jsonText.length > 1_000 ? `${jsonText.slice(0, 1_000)}…` : jsonText;
    throw new Error(
      [
        "stale-doc detector returned invalid JSON. Expected a JSON array.",
        `Parse error: ${detail}`,
        "Output excerpt:",
        excerpt || "(empty output)",
      ].join("\n"),
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("stale-doc detector did not return a JSON array.");
  }
  return parsed.map((task, index) => ({
    id: sanitizeSegment(String(task.id || `doc-task-${index + 1}`)),
    title: String(task.title || `Documentation task ${index + 1}`),
    owner_docs: Array.isArray(task.owner_docs) ? task.owner_docs.map(String) : [],
    reason: String(task.reason || ""),
    source_refs: Array.isArray(task.source_refs) ? task.source_refs.map(String) : [],
    update_instructions: String(task.update_instructions || ""),
    acceptance_criteria: Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria.map(String) : [],
  }));
};

export const nextDocsValidationPhase = (initialValidationOk: boolean): DocsValidationPhase =>
  initialValidationOk ? "skip_repair" : "repair_then_revalidate";

export const findMissingOrEmptyUpdateArtifacts = (
  artifacts: readonly UpdateArtifactStatus[],
): UpdateArtifactStatus[] => artifacts.filter((artifact) => !artifact.exists || artifact.empty);

export const verifyReleaseDocsPr = (
  currentBranch: string,
  baseBranch = DEFAULT_RELEASE_DOCS_BASE_BRANCH,
  cwd = repoRoot(),
  runner: CommandRunner = runCommandResult,
): GhPrVerification => {
  const result = runner(
    "gh",
    [
      "pr",
      "list",
      "--head",
      currentBranch,
      "--base",
      baseBranch,
      "--state",
      "open",
      "--json",
      "url,headRefName,baseRefName,state",
      "--limit",
      "1",
      "--jq",
      ".[0]",
    ],
    cwd,
  );

  if (!result.ok) {
    return {
      ok: false,
      summary: ["Unable to verify release docs PR with gh.", `Command: ${result.command}`, result.output].join("\n"),
    };
  }

  type GhPrRecord = {
    url?: string;
    headRefName?: string;
    baseRefName?: string;
    state?: string;
  };

  let parsed: GhPrRecord | null;
  try {
    parsed = JSON.parse(result.output || "null") as GhPrRecord | null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      summary: ["Unable to parse gh PR verification output.", `Parse error: ${detail}`, result.output].join("\n"),
    };
  }

  const ok =
    parsed !== null &&
    parsed.headRefName === currentBranch &&
    parsed.baseRefName === baseBranch &&
    parsed.state === "OPEN" &&
    typeof parsed.url === "string" &&
    parsed.url.length > 0;

  const url = parsed?.url;
  return {
    ok,
    url,
    summary: ok
      ? `Verified open PR ${url} from ${currentBranch} to ${baseBranch}.`
      : `gh did not return an open PR matching head=${currentBranch} and base=${baseBranch}: ${result.output || "null"}`,
  };
};

class DisjointSet {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    const parent = this.parent[index];
    if (parent === index) return index;
    const root = this.find(parent);
    this.parent[index] = root;
    return root;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) {
      this.parent[rightRoot] = leftRoot;
    }
  }
}

const mergeTaskGroup = (tasks: readonly StaleDocTask[], firstIndex: number): StaleDocTask => {
  if (tasks.length === 1) {
    const [task] = tasks;
    return {
      ...task,
      owner_docs: dedupeOwnerDocs(task.owner_docs),
      source_refs: dedupeStrings(task.source_refs),
      acceptance_criteria: dedupeStrings(task.acceptance_criteria),
    };
  }

  const ids = tasks.map((task) => sanitizeSegment(task.id));
  const baseId = sanitizeSegment(`merged-${firstIndex + 1}-${ids.join("-")}`);
  const id = baseId.length > 120 ? baseId.slice(0, 120).replace(/-+$/g, "") : baseId;

  return {
    id,
    title: `Merged stale docs updates: ${tasks.map((task) => task.title).join("; ")}`,
    owner_docs: dedupeOwnerDocs(tasks.flatMap((task) => task.owner_docs)),
    reason: tasks.map((task) => `- ${task.id}: ${task.reason}`).join("\n"),
    source_refs: dedupeStrings(tasks.flatMap((task) => task.source_refs)),
    update_instructions: tasks.map((task) => `## ${task.id}: ${task.title}\n${task.update_instructions}`).join("\n\n"),
    acceptance_criteria: dedupeStrings(tasks.flatMap((task) => task.acceptance_criteria)),
  };
};

export const mergeStaleDocTasksByOwnerDocs = (tasks: readonly StaleDocTask[]): StaleDocTask[] => {
  if (tasks.length < 2) {
    return tasks.map((task, index) => mergeTaskGroup([task], index));
  }

  const groups = new DisjointSet(tasks.length);
  const ownerDocToFirstTask = new Map<string, number>();

  tasks.forEach((task, taskIndex) => {
    for (const ownerDoc of dedupeOwnerDocs(task.owner_docs)) {
      const firstTaskIndex = ownerDocToFirstTask.get(ownerDoc);
      if (firstTaskIndex === undefined) {
        ownerDocToFirstTask.set(ownerDoc, taskIndex);
      } else {
        groups.union(firstTaskIndex, taskIndex);
      }
    }
  });

  const components = new Map<number, { firstIndex: number; tasks: StaleDocTask[] }>();
  tasks.forEach((task, taskIndex) => {
    const root = groups.find(taskIndex);
    const component = components.get(root);
    if (component === undefined) {
      components.set(root, { firstIndex: taskIndex, tasks: [task] });
      return;
    }
    component.tasks.push(task);
  });

  return [...components.values()]
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .map((component) => mergeTaskGroup(component.tasks, component.firstIndex));
};

export const runDocsChecks = (): { ok: boolean; markdown: string } => {
  const checks = [
    {
      label: "Hosted docs route/internal-link validation",
      command: "bun",
      args: ["run", "docs:check"],
      cwd: join(repoRoot(), "packages/coding-agent"),
    },
    {
      label: "Mintlify syntax validation",
      command: "bunx",
      args: ["--bun", "mintlify@latest", "validate"],
      cwd: join(repoRoot(), "packages/coding-agent/docs"),
    },
    {
      label: "Mintlify broken-link validation",
      command: "bunx",
      args: ["--bun", "mintlify@latest", "broken-links"],
      cwd: join(repoRoot(), "packages/coding-agent/docs"),
    },
  ];

  const results = checks.map((check) => ({ ...check, result: runCommandResult(check.command, check.args, check.cwd) }));
  const ok = results.every((check) => check.result.ok);
  const markdown = results
    .map((check) =>
      [
        `## ${check.label}`,
        "",
        `Command: \`${check.result.command}\``,
        `Cwd: \`${check.cwd}\``,
        `Status: ${check.result.ok ? "pass" : "fail"}`,
        "",
        "```text",
        check.result.output || "(no output)",
        "```",
      ].join("\n"),
    )
    .join("\n\n");

  return { ok, markdown };
};
