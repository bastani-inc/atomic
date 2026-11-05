/**
 * The project group a session joins by default while multi-node routing is selected, so sessions of different
 * repositories sharing one database cannot address each other unless they choose a common group.
 * Host-free: callers pass the Git environment and the storage environment the broker would receive.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readSharedStorageSetting } from "./broker/shared-storage-setting.js";

export const PROJECT_GROUP_PREFIX = "project:";
/** Shown once when a session joins `default` explicitly while multi-node routing is on. */
export const DEFAULT_GROUP_WARNING =
  'Warning: multi-node routing is on, so every teammate\'s sessions on the shared database can address the "default" group.';

const projects = new Map<string, string>();
/** `git remote get-url` exits with 2 when the remote does not exist. */
const NO_SUCH_REMOTE = 2;

/**
 * The repository path a remote URL names, such as `owner/repo` for `https://github.com/owner/repo.git` or
 * `git@github.com:owner/repo.git`, without user name, password, port, query or a trailing `.git`.
 */
export function remoteRepositoryPath(remote: string): string | undefined {
  const url = remote.trim();
  let path: string;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(url)) {
    if (!URL.canParse(url)) return undefined;
    path = new URL(url).pathname;
  } else {
    path = /^(?:[^@/\\]+@)?[^:/\\]+:(.+)$/.exec(url)?.[1] ?? url;
  }
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
  const last = segments.at(-1)?.replace(/\.git$/, "");
  if (last === undefined || last.length === 0) return undefined;
  return [...segments.slice(0, -1), last].join("/");
}

export type ProjectGroupErrorCode = "git-unavailable" | "git-failed";

const SUMMARIES: Readonly<Record<ProjectGroupErrorCode, string>> = {
  "git-unavailable": "Git is needed to name this repository's Intercom project group",
  "git-failed": "Git could not read this repository's origin for its Intercom project group",
};

/** The command that installs Git on this platform. */
export function gitInstallCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "winget install --id Git.Git -e";
  if (platform === "darwin") return "xcode-select --install";
  return "sudo apt-get install git (or your distribution's package manager)";
}

/**
 * The project group of a Git working tree cannot be named: Git is not installed, or it failed in that directory.
 * A session with multi-node routing on needs it before it joins Intercom, unless it names its group explicitly.
 */
export class ProjectGroupError extends Error {
  override readonly name = "ProjectGroupError" as const;
  readonly code: ProjectGroupErrorCode;
  readonly cwd: string;
  readonly hint: string;
  readonly detail?: string;
  readonly retryable = false;

  constructor(
    code: ProjectGroupErrorCode,
    fields: { readonly cwd: string; readonly hint: string; readonly detail?: string; readonly cause?: Error },
  ) {
    super(
      `${SUMMARIES[code]}: ${fields.cwd} (${code})${fields.detail === undefined ? "" : `: ${fields.detail}`}. ${fields.hint}`,
      fields.cause === undefined ? undefined : { cause: fields.cause },
    );
    this.code = code;
    this.cwd = fields.cwd;
    this.hint = fields.hint;
    if (fields.detail !== undefined) this.detail = fields.detail;
  }
}

/** Whether `error` is a {@link ProjectGroupError}, also across realms and processes (by `name` and `code`). */
export function isProjectGroupError(error: unknown): error is ProjectGroupError {
  if (error instanceof ProjectGroupError) return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly name?: unknown; readonly code?: unknown };
  return candidate.name === "ProjectGroupError" && (candidate.code === "git-unavailable" || candidate.code === "git-failed");
}

const EXPLICIT_GROUP_HINT = "or set ATOMIC_INTERCOM_GROUP to choose this session's group";

/** The directory holding `.git` at or above `directory`, without running Git. */
function repositoryMarker(directory: string): string | undefined {
  for (let current = directory; ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
    if (dirname(current) === current) return undefined;
  }
}

function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw new ProjectGroupError("git-unavailable", {
      cwd,
      detail: result.error.message,
      hint: `Install Git (${gitInstallCommand()}), ${EXPLICIT_GROUP_HINT}.`,
      cause: result.error,
    });
  }
  return result;
}

function gitFailed(cwd: string, args: readonly string[], result: SpawnSyncReturns<string>): ProjectGroupError {
  const detail = result.stderr.trim().split("\n", 1)[0] || `git exited with status ${result.status}`;
  return new ProjectGroupError("git-failed", {
    cwd,
    detail,
    hint: `Run git -C ${cwd} ${args.join(" ")} to see why and fix the repository, ${EXPLICIT_GROUP_HINT}.`,
  });
}

/**
 * The project a working directory belongs to: the origin remote's repository path, else the repository's directory
 * name, else (outside Git, where no `.git` exists at or above it) the working directory's name. Git runs at most
 * twice per directory per process, and never outside a repository. Inside one, a missing or failing Git throws
 * {@link ProjectGroupError} rather than guessing.
 */
export function projectName(cwd: string, gitEnv: NodeJS.ProcessEnv): string {
  const directory = resolve(cwd);
  const known = projects.get(directory);
  if (known !== undefined) return known;
  let name: string;
  if (repositoryMarker(directory) === undefined) {
    name = basename(directory) || directory;
  } else {
    const topLevelArgs = ["rev-parse", "--show-toplevel"];
    const topLevel = git(directory, topLevelArgs, gitEnv);
    if (topLevel.status !== 0) throw gitFailed(directory, topLevelArgs, topLevel);
    const root = topLevel.stdout.trim();
    const originArgs = ["remote", "get-url", "origin"];
    const origin = git(directory, originArgs, gitEnv);
    if (origin.status !== 0 && origin.status !== NO_SUCH_REMOTE) throw gitFailed(directory, originArgs, origin);
    const fromOrigin = origin.status === 0 ? remoteRepositoryPath(origin.stdout) : undefined;
    name = fromOrigin ?? (basename(root) || root);
  }
  projects.set(directory, name);
  return name;
}

/** The group name for a project, `project:<owner>/<repo>`. */
export function projectGroup(cwd: string, gitEnv: NodeJS.ProcessEnv): string {
  return `${PROJECT_GROUP_PREFIX}${projectName(cwd, gitEnv)}`;
}

/**
 * Whether a broker started with this storage environment would route across machines: a shared `storage`
 * selection that is not in memory, as `atomic storage status` reports multi-node routing.
 */
export function multiNodeSelected(agentDir: string, storageEnv: NodeJS.ProcessEnv): boolean {
  return readSharedStorageSetting(agentDir, storageEnv) !== undefined;
}

/** The project group a session in `cwd` joins by default, or `undefined` while multi-node routing is off. */
export function projectHomeGroup(
  cwd: string,
  agentDir: string,
  storageEnv: NodeJS.ProcessEnv,
  gitEnv: NodeJS.ProcessEnv,
): string | undefined {
  return multiNodeSelected(agentDir, storageEnv) ? projectGroup(cwd, gitEnv) : undefined;
}
