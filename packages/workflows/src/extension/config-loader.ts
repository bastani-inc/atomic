/**
 * Workflow extension config loader.
 *
 * Reads project-local and user-global workflow extension config files,
 * validates their shape, and returns a merged config plus diagnostics.
 *
 * Config file candidates (first readable wins per scope):
 *   Project-local:
 *     <projectRoot>/.atomic/extensions/workflow/config.json
 *   User-global:
 *     <agentDir>/extensions/workflow/config.json
 * Invalid JSON or invalid shape → CONFIG_INVALID diagnostic (not silent success).
 * Missing file → silently skipped (not an error).
 *
 * Merge strategy: project-local values override global values.
 * The `workflows` map is merged key-by-key (project entries win on conflict).
 */

import { join, isAbsolute } from "node:path";
import { CONFIG_DIR_NAME, CONFIG_DIR_NAMES, getAgentDir, getAgentDirs, getProjectConfigPaths } from "@bastani/atomic";
import type { WorkflowLifecycleNoticeKind } from "./lifecycle-notifications.js";
import { loadConfigFile } from "./config-file-loader.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single explicit workflow entry from config. */
export interface WorkflowConfigEntry {
  /** Absolute or relative path to the workflow module. */
  readonly path: string;
}

/**
 * The parsed shape of a workflow extension config file.
 * All fields optional; absence means "use default".
 */
export interface WorkflowNotificationsConfig {
  /** Emit lifecycle notices into the main chat. Default: true. */
  readonly enabled?: boolean;
  /** Lifecycle states that should create chat notices. */
  readonly notifyOn?: readonly WorkflowLifecycleNoticeKind[];
}

export interface WorkflowWorktreeConfig {
  /** Main-root directories symlinked into temporary worktrees. */
  readonly symlinkDirectories?: readonly string[];
}
export interface WorkflowExtensionConfig {
  /** Explicit named workflows to register by module path. */
  readonly workflows?: Readonly<Record<string, WorkflowConfigEntry>>;
  /** Maximum workflow recursion depth. Default: 4. */
  readonly maxDepth?: number;
  /** Default stage concurrency. Default: 4. */
  readonly defaultConcurrency?: number;
  /** Persist runs via pi appendEntry. Default: true. */
  readonly persistRuns?: boolean;
  /** Emit derived status.json for CI polling. Default: false. */
  readonly statusFile?: boolean;
  /** Behaviour on session_start for in-flight runs. Default: "ask". */
  readonly resumeInFlight?: "ask" | "auto" | "never";
  /** Main-chat workflow lifecycle notices. */
  readonly workflowNotifications?: WorkflowNotificationsConfig;
  /** Temporary-worktree post-creation settings. */
  readonly worktree?: WorkflowWorktreeConfig;
}

/** Severity of a config diagnostic. */
export type ConfigDiagnosticLevel = "error" | "warn";

/** A diagnostic emitted while loading config. */
export interface ConfigDiagnostic {
  readonly level: ConfigDiagnosticLevel;
  /** Machine-readable code. */
  readonly code: "CONFIG_INVALID";
  readonly message: string;
  /** The config file path associated with this diagnostic. */
  readonly source?: string;
}

/** Result of a config load operation. */
export interface ConfigLoadResult {
  /**
   * Merged config from all valid sources.
   * null only if no config file existed and no defaults apply.
   * Present (possibly empty object) when at least one valid file loaded.
   */
  readonly config: WorkflowExtensionConfig | null;
  /**
   * Pre-merge global config (from <agentDir>/extensions/workflow/config.json).
   * null when the global file is absent or invalid. Absent on results from callers
   * that constructed ConfigLoadResult before this field was added.
   */
  readonly globalConfig?: WorkflowExtensionConfig | null;
  /**
   * Pre-merge project config (from first valid project-local candidate).
   * null when no project-local file is found or all are invalid. Absent on results
   * from callers that constructed ConfigLoadResult before this field was added.
   */
  readonly projectConfig?: WorkflowExtensionConfig | null;
  /** CONFIG_INVALID diagnostics from all sources. Empty when all is well. */
  readonly diagnostics: readonly ConfigDiagnostic[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface LoadWorkflowConfigOpts {
  /**
   * Project root directory. Defaults to process.cwd().
   * Project-local config is resolved relative to this path.
   */
  readonly projectRoot?: string;
  /**
   * User home directory. When set, preserves legacy test/compat resolution
   * relative to <homeDir>/.atomic/agent and <homeDir>/.pi/agent.
   */
  readonly homeDir?: string;
  /**
   * User agent config directories in precedence order. Defaults to Atomic's
   * configured agent directories, honoring ATOMIC_CODING_AGENT_DIR.
   */
  readonly agentDirs?: readonly string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Merge two configs: `override` values win over `base`.
 * The `workflows` map is merged key-by-key (override wins on conflict).
 */
function mergeConfigs(
  base: WorkflowExtensionConfig,
  override: WorkflowExtensionConfig,
): WorkflowExtensionConfig {
  const workflows =
    base.workflows || override.workflows
      ? { ...(base.workflows ?? {}), ...(override.workflows ?? {}) }
      : undefined;

  return {
    ...(base.maxDepth !== undefined || override.maxDepth !== undefined
      ? { maxDepth: override.maxDepth ?? base.maxDepth }
      : {}),
    ...(base.defaultConcurrency !== undefined || override.defaultConcurrency !== undefined
      ? { defaultConcurrency: override.defaultConcurrency ?? base.defaultConcurrency }
      : {}),
    ...(base.persistRuns !== undefined || override.persistRuns !== undefined
      ? { persistRuns: override.persistRuns ?? base.persistRuns }
      : {}),
    ...(base.statusFile !== undefined || override.statusFile !== undefined
      ? { statusFile: override.statusFile ?? base.statusFile }
      : {}),
    ...(base.resumeInFlight !== undefined || override.resumeInFlight !== undefined
      ? { resumeInFlight: override.resumeInFlight ?? base.resumeInFlight }
      : {}),
    ...(base.workflowNotifications !== undefined || override.workflowNotifications !== undefined
      ? {
          workflowNotifications: {
            ...(base.workflowNotifications ?? {}),
            ...(override.workflowNotifications ?? {}),
          },
        }
      : {}),
    ...(base.worktree !== undefined || override.worktree !== undefined
      ? { worktree: { ...(base.worktree ?? {}), ...(override.worktree ?? {}) } }
      : {}),
    ...(workflows !== undefined ? { workflows } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Canonical default values for all WorkflowExtensionConfig tunables.
 */
export const WORKFLOW_CONFIG_DEFAULTS = {
  maxDepth: 4,
  defaultConcurrency: 4,
  persistRuns: true,
  statusFile: false,
  resumeInFlight: "ask" as const,
  workflowNotifications: {
    enabled: true,
    notifyOn: ["completed", "failed", "blocked", "awaiting_input"] as const,
  },
  worktree: {
    symlinkDirectories: ["node_modules"] as readonly string[],
  },
} as const;

/**
 * Effective config shape — all optional fields resolved to concrete values.
 * The `workflows` map remains optional (no sensible scalar default).
 */
export interface WorkflowEffectiveConfig {
  readonly maxDepth: number;
  readonly defaultConcurrency: number;
  readonly persistRuns: boolean;
  readonly statusFile: boolean;
  readonly resumeInFlight: "ask" | "auto" | "never";
  readonly workflowNotifications: {
    readonly enabled: boolean;
    readonly notifyOn: readonly WorkflowLifecycleNoticeKind[];
  };
  readonly worktree: {
    readonly symlinkDirectories: readonly string[];
  };
  readonly workflows?: Readonly<Record<string, WorkflowConfigEntry>>;
}

/**
 * Apply default values to a WorkflowExtensionConfig, filling in every absent
 * optional field with its RFC-specified default.
 *
 * Pure function — does not mutate the input.
 */
export function withWorkflowDefaults(
  config: WorkflowExtensionConfig,
): WorkflowEffectiveConfig {
  return {
    maxDepth: config.maxDepth ?? WORKFLOW_CONFIG_DEFAULTS.maxDepth,
    defaultConcurrency:
      config.defaultConcurrency ?? WORKFLOW_CONFIG_DEFAULTS.defaultConcurrency,
    persistRuns: config.persistRuns ?? WORKFLOW_CONFIG_DEFAULTS.persistRuns,
    statusFile: config.statusFile ?? WORKFLOW_CONFIG_DEFAULTS.statusFile,
    resumeInFlight:
      config.resumeInFlight ?? WORKFLOW_CONFIG_DEFAULTS.resumeInFlight,
    workflowNotifications: {
      enabled:
        config.workflowNotifications?.enabled
        ?? WORKFLOW_CONFIG_DEFAULTS.workflowNotifications.enabled,
      notifyOn:
        config.workflowNotifications?.notifyOn
        ?? WORKFLOW_CONFIG_DEFAULTS.workflowNotifications.notifyOn,
    },
    worktree: {
      symlinkDirectories:
        config.worktree?.symlinkDirectories
        ?? WORKFLOW_CONFIG_DEFAULTS.worktree.symlinkDirectories,
    },
    ...(config.workflows !== undefined ? { workflows: config.workflows } : {}),
  };
}

// ---------------------------------------------------------------------------
// Discovery config mapping
// ---------------------------------------------------------------------------

/**
 * Options for toScopedDiscoveryConfig().
 */
export interface ScopedDiscoveryConfigOpts {
  /**
   * Project root directory. Relative paths in projectConfig.workflows are
   * resolved relative to this directory.
   */
  readonly projectRoot: string;
  /**
   * User home directory. When set, relative paths in globalConfig.workflows
   * resolve relative to <homeDir>/.atomic/agent.
   */
  readonly homeDir?: string;
  /**
   * User agent config directory. Defaults to Atomic's configured agent dir,
   * honoring ATOMIC_CODING_AGENT_DIR.
   */
  readonly agentDir?: string;
}

export interface ScopedDiscoveryConfig {
  projectWorkflows?: Record<string, string>;
  globalWorkflows?: Record<string, string>;
}

function hasWorkflows(config: WorkflowExtensionConfig | null): config is WorkflowExtensionConfig & {
  workflows: Readonly<Record<string, WorkflowConfigEntry>>;
} {
  return config?.workflows !== undefined && Object.keys(config.workflows).length > 0;
}

function resolveWorkflowPaths(
  workflows: Readonly<Record<string, WorkflowConfigEntry>> | undefined,
  baseDir: string,
): Record<string, string> | undefined {
  if (workflows === undefined || Object.keys(workflows).length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(workflows).map(([name, entry]) => [
      name,
      isAbsolute(entry.path) ? entry.path : join(baseDir, entry.path),
    ]),
  );
}

function workflowAgentDirs(opts: Pick<LoadWorkflowConfigOpts, "agentDirs" | "homeDir">): readonly string[] {
  if (opts.agentDirs !== undefined) return opts.agentDirs;
  if (opts.homeDir !== undefined) {
    const homeDir = opts.homeDir;
    return CONFIG_DIR_NAMES.map((name) => join(homeDir, name, "agent"));
  }
  return getAgentDirs();
}

/**
 * Build a scope-aware DiscoveryConfig from the pre-merge global and project configs.
 *
 * Scope rules:
 *   - globalConfig.workflows entries → DiscoveryConfig.globalWorkflows
 *     Relative paths are resolved under the configured Atomic agent dir.
 *   - projectConfig.workflows entries → DiscoveryConfig.projectWorkflows
 *     Relative paths are resolved under projectRoot.
 *   - When both configs define the same workflow key, the project entry wins
 *     and the global entry for that key is excluded from globalWorkflows.
 *
 * Absolute paths are kept as-is regardless of scope.
 * Returns an empty object when both configs are null or have no workflows.
 */
export function toScopedDiscoveryConfig(
  globalConfig: WorkflowExtensionConfig | null,
  projectConfig: WorkflowExtensionConfig | null,
  opts: ScopedDiscoveryConfigOpts,
): ScopedDiscoveryConfig {
  const globalBase = opts.agentDir
    ?? (opts.homeDir === undefined ? getAgentDir() : join(opts.homeDir, CONFIG_DIR_NAME, "agent"));
  const projectBase = opts.projectRoot;

  const result: ScopedDiscoveryConfig = {};
  const projectWorkflows = resolveWorkflowPaths(projectConfig?.workflows, projectBase);

  if (projectWorkflows !== undefined) {
    result.projectWorkflows = projectWorkflows;
  }

  if (hasWorkflows(globalConfig)) {
    const projectKeys = new Set(Object.keys(projectWorkflows ?? {}));
    const globalEntries = Object.entries(globalConfig.workflows)
      .filter(([name]) => !projectKeys.has(name))
      .map(([name, entry]): [string, string] => {
        return [
          name,
          isAbsolute(entry.path) ? entry.path : join(globalBase, entry.path),
        ];
      });

    if (globalEntries.length > 0) {
      result.globalWorkflows = Object.fromEntries(globalEntries);
    }
  }

  return result;
}

/**
 * Load and merge workflow extension config from all candidate locations.
 *
 * Candidate paths (in resolution order):
 *   Global (lowest priority):
 *     <agentDir>/extensions/workflow/config.json
 *   Project-local (highest priority, first existing wins):
 *     <projectRoot>/.atomic/extensions/workflow/config.json
 * Merge: project-local overrides global. Key-level merge for `workflows` map.
 * Missing files: silently ignored. Invalid files: CONFIG_INVALID diagnostic.
 */
export async function loadWorkflowConfig(
  opts: LoadWorkflowConfigOpts = {},
): Promise<ConfigLoadResult> {
  const projectRoot = opts.projectRoot ?? process.cwd();

  const diagnostics: ConfigDiagnostic[] = [];

  // Global config paths (primary Atomic first, then legacy pi/defaults).
  const globalCandidates = workflowAgentDirs(opts).map((agentDir) =>
    join(agentDir, "extensions", "workflow", "config.json")
  );

  // Project-local config paths (primary Atomic first, then legacy pi)
  const projectCandidates: string[] = getProjectConfigPaths(projectRoot, "extensions", "workflow", "config.json");

  // Load global config (primary overrides legacy)
  let globalConfig: WorkflowExtensionConfig | null = null;
  for (let i = globalCandidates.length - 1; i >= 0; i--) {
    const globalPath = globalCandidates[i]!;
    const outcome = await loadConfigFile(globalPath);
    if (outcome.kind === "error") {
      diagnostics.push(outcome.diagnostic);
    } else if (outcome.kind === "ok") {
      globalConfig = globalConfig ? mergeConfigs(globalConfig, outcome.parsed) : outcome.parsed;
    }
    // "missing" → silently skip
  }

  // Load project-local configs (primary overrides legacy)
  let projectConfig: WorkflowExtensionConfig | null = null;
  for (let i = projectCandidates.length - 1; i >= 0; i--) {
    const candidatePath = projectCandidates[i]!;
    const outcome = await loadConfigFile(candidatePath);
    if (outcome.kind === "missing") continue;
    if (outcome.kind === "error") {
      diagnostics.push(outcome.diagnostic);
    } else {
      projectConfig = projectConfig ? mergeConfigs(projectConfig, outcome.parsed) : outcome.parsed;
    }
  }

  // Merge: start from global, apply project override
  let merged: WorkflowExtensionConfig | null = null;
  if (globalConfig !== null && projectConfig !== null) {
    merged = mergeConfigs(globalConfig, projectConfig);
  } else if (projectConfig !== null) {
    merged = projectConfig;
  } else if (globalConfig !== null) {
    merged = globalConfig;
  }

  // If we had any valid source (even empty object), return it
  // If only diagnostics and no valid config, return null
  return {
    config: merged,
    globalConfig,
    projectConfig,
    diagnostics,
  };
}
