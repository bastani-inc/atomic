/**
 * Programmatic entry for the scaffold. The CLI wrapper lives in `cli.ts`
 * and translates argv/prompts into a `ScaffoldOptions` call to `scaffold`.
 *
 * Two templates:
 *   - "atomic-workflow" → a self-contained Bun package under
 *     `<scope>/.atomic/workflows/<name>/` plus a registry entry merged
 *     into `<scope>/.atomic/settings.json`.
 *   - "standalone-cli" → a third-party CLI under `<cwd>/<name>/` with a
 *     `bun build --compile` script and a sample workflow bundled in.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderTree, type Vars } from "./render.ts";
import { mergeSettings } from "./settings-merge.ts";

export type Template = "atomic-workflow" | "standalone-cli";
export type Scope = "project" | "global";
export type Agent = "claude" | "copilot" | "opencode";

export interface ScaffoldOptions {
  /** Project name. Used as directory name and `package.json#name`. */
  name: string;
  /** Which template. */
  template: Template;
  /** Only for atomic-workflow: project-level vs user-global. */
  scope?: Scope;
  /** Default agent. Only Claude is wired up to a sample SDK call right now. */
  agent: Agent;
  /** Cwd to place the project under. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Where to read/write the global settings file. Defaults to `~/.atomic/`.
   * Threaded through so tests can point it at a tmp dir without touching
   * the real `~/.atomic`.
   */
  globalAtomicHome?: string;
}

export interface ScaffoldResult {
  /** Absolute path to the scaffolded project root. */
  projectDir: string;
  /** Absolute path to the settings.json that was touched (atomic-workflow only). */
  settingsPath?: string;
  /** Whether settings.json was created vs merged into an existing file. */
  settingsCreated?: boolean;
}

const PROVIDER_SDK: Record<Agent, { pkg: string; version: string }> = {
  claude: { pkg: "@anthropic-ai/claude-agent-sdk", version: "^0.1.0" },
  copilot: { pkg: "@github/copilot-sdk", version: "^0.1.0" },
  opencode: { pkg: "@opencode-ai/sdk", version: "^0.1.0" },
};

const SESSION_CALL: Record<Agent, string> = {
  claude: `await s.session.query(ctx.inputs.prompt);`,
  copilot: `await s.session.send(ctx.inputs.prompt);`,
  opencode: `await s.client.session.prompt(s.sessionId, ctx.inputs.prompt);`,
};

/** Locate the `templates/` dir whether we're running from source or installed. */
function templatesRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "templates");
}

/**
 * Validate a project name as a directory name + package.json `name`.
 * npm package names allow hyphens, lowercase letters, digits, and dots;
 * we deliberately disallow uppercase + leading dots/slashes.
 */
export function validateName(name: string): string | null {
  if (!name || name.trim() === "") return "name cannot be empty";
  if (name !== name.toLowerCase()) return "name must be lowercase";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return "name must start with a-z or 0-9 and contain only lowercase letters, digits, and hyphens";
  }
  if (name.length > 64) return "name is too long (max 64 chars)";
  return null;
}

export async function scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const nameError = validateName(opts.name);
  if (nameError) throw new Error(nameError);
  const cwd = opts.cwd ?? process.cwd();
  const provider = PROVIDER_SDK[opts.agent];
  const sessionCall = SESSION_CALL[opts.agent];

  if (opts.template === "atomic-workflow") {
    return scaffoldAtomicWorkflow(opts, cwd, provider, sessionCall);
  }
  return scaffoldStandaloneCli(opts, cwd, provider, sessionCall);
}

function scaffoldAtomicWorkflow(
  opts: ScaffoldOptions,
  cwd: string,
  provider: { pkg: string; version: string },
  sessionCall: string,
): ScaffoldResult {
  const scope = opts.scope ?? "project";
  const atomicHome =
    scope === "global"
      ? opts.globalAtomicHome ?? path.join(homedir(), ".atomic")
      : path.join(cwd, ".atomic");
  const projectDir = path.join(atomicHome, "workflows", opts.name);
  const settingsPath = path.join(atomicHome, "settings.json");

  if (existsSync(projectDir)) {
    throw new Error(`Refusing to overwrite existing directory: ${projectDir}`);
  }

  // Compose the scaffold-time variables.
  const settingsPathLabel =
    scope === "global"
      ? "~/.atomic/settings.json"
      : ".atomic/settings.json";
  const vars: Vars = {
    name: opts.name,
    description: defaultDescription(opts.template, opts.name),
    agent: opts.agent,
    providerSdkPkg: provider.pkg,
    providerSdkVersion: provider.version,
    sessionCall,
    settingsPathLabel,
  };

  renderTree(
    path.join(templatesRoot(), "atomic-workflow"),
    projectDir,
    vars,
  );

  // Registry entry — `args` path differs by scope. Project entries use a
  // repo-relative path so the same entry works on every machine that
  // clones the repo. Global entries use an absolute path under
  // `~/.atomic/workflows/` because there's no consistent `cwd` to anchor
  // a relative path to when atomic resolves it.
  const argsPath =
    scope === "global"
      ? path.join(atomicHome, "workflows", opts.name, "index.ts")
      : `./.atomic/workflows/${opts.name}/index.ts`;
  const result = mergeSettings({
    settingsPath,
    alias: opts.name,
    entry: {
      command: "bunx",
      args: [argsPath],
      agents: [opts.agent],
    },
  });

  return {
    projectDir,
    settingsPath,
    settingsCreated: !result.existed,
  };
}

function scaffoldStandaloneCli(
  opts: ScaffoldOptions,
  cwd: string,
  provider: { pkg: string; version: string },
  sessionCall: string,
): ScaffoldResult {
  const projectDir = path.join(cwd, opts.name);
  if (existsSync(projectDir)) {
    throw new Error(`Refusing to overwrite existing directory: ${projectDir}`);
  }

  mkdirSync(projectDir, { recursive: true });

  const vars: Vars = {
    name: opts.name,
    description: defaultDescription(opts.template, opts.name),
    agent: opts.agent,
    providerSdkPkg: provider.pkg,
    providerSdkVersion: provider.version,
    sessionCall,
  };

  renderTree(
    path.join(templatesRoot(), "standalone-cli"),
    projectDir,
    vars,
  );

  return { projectDir };
}

function defaultDescription(template: Template, name: string): string {
  if (template === "atomic-workflow") {
    return `Atomic-managed workflow: ${name}.`;
  }
  return `Third-party CLI built on @bastani/atomic-sdk: ${name}.`;
}
