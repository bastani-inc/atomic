import { basename } from "node:path";
import type {
  CreateAgentSessionOptions,
  DefaultResourceLoaderInheritanceSnapshot,
  PackageSource,
} from "@bastani/atomic";
import type { StageSessionRuntime } from "../runs/foreground/stage-runner.js";

export interface PiSdkSettingsManager {
  getCodexFastModeSettings(): { readonly chat: boolean; readonly workflow: boolean };
}

export interface PiSdkResourceLoader {
  reload(): Promise<void>;
}

interface PiSdkSessionManager {
  getCwd(): string;
}

export interface PiCodingAgentSdk {
  getAgentDir(): string;
  getBuiltinPackagePaths?: () => string[];
  SettingsManager: {
    create(cwd?: string, agentDir?: string, options?: { projectTrusted?: boolean }): PiSdkSettingsManager;
  };
  DefaultResourceLoader: new (options: {
    cwd: string;
    agentDir: string;
    settingsManager?: PiSdkSettingsManager;
    builtinPackagePaths?: PackageSource[];
    resourceLoaderInheritanceSnapshot?: DefaultResourceLoaderInheritanceSnapshot;
  }) => PiSdkResourceLoader;
  createAgentSession(options?: AtomicCreateAgentSessionOptions): Promise<{ session: StageSessionRuntime }>;
}

export type AtomicCreateAgentSessionOptions = Omit<CreateAgentSessionOptions, "settingsManager" | "resourceLoader" | "sessionManager"> & {
  settingsManager?: PiSdkSettingsManager;
  resourceLoader?: PiSdkResourceLoader;
  sessionManager?: PiSdkSessionManager;
};

export interface PrepareAtomicStageSessionOptions {
  resourceLoaderInheritanceSnapshot?: DefaultResourceLoaderInheritanceSnapshot;
}

function resolveSessionCwd(options: AtomicCreateAgentSessionOptions | undefined): string {
  return options?.cwd ?? options?.sessionManager?.getCwd() ?? process.cwd();
}

/**
 * Prepare Atomic SDK stage-session options with Atomic-first resource loading.
 *
 * The Atomic SDK's documented defaults are intentionally significant:
 * omitted `agentDir` means credentials/models/settings can be read from the
 * primary `~/.atomic/agent` paths first while still considering legacy
 * `~/.pi/agent` compatibility paths when the SDK supports multiple config
 * directories. Passing the computed default back as an explicit `agentDir`
 * would accidentally turn that multi-dir behavior into a single-dir override.
 *
 * A user-supplied `agentDir` is still preserved exactly and remains an
 * explicit override. A user-supplied `resourceLoader` is also preserved; in
 * that case cwd/agentDir no longer control resource discovery and only affect
 * session naming/tool path resolution, matching the pi SDK docs.
 */
export async function prepareAtomicStageSessionOptions(
  options: CreateAgentSessionOptions | undefined,
  sdk: PiCodingAgentSdk,
  prepareOptions: PrepareAtomicStageSessionOptions = {},
): Promise<AtomicCreateAgentSessionOptions | undefined> {
  const atomicOptions = options as AtomicCreateAgentSessionOptions | undefined;
  if (atomicOptions?.resourceLoader !== undefined) return atomicOptions;

  const inheritanceSnapshot = prepareOptions.resourceLoaderInheritanceSnapshot;
  const cwd = resolveSessionCwd(atomicOptions);
  const hasAgentDirOverride = atomicOptions?.agentDir !== undefined;
  const agentDir = atomicOptions?.agentDir ?? sdk.getAgentDir();
  const settingsManager =
    atomicOptions?.settingsManager ?? sdk.SettingsManager.create(
      cwd,
      agentDir,
      inheritanceSnapshot?.projectTrusted === undefined
        ? undefined
        : { projectTrusted: inheritanceSnapshot.projectTrusted },
    );
  const inheritedBuiltinPackagePaths = inheritanceSnapshot?.builtinPackagePaths;
  const builtinPackagePaths = inheritedBuiltinPackagePaths === undefined
    ? sdk.getBuiltinPackagePaths?.() ?? []
    : [...inheritedBuiltinPackagePaths];
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    resourceLoaderInheritanceSnapshot: inheritanceSnapshot,
    builtinPackagePaths: stageBuiltinPackagePaths(builtinPackagePaths),
  });
  await reloadWorkflowStageResources(resourceLoader);

  return {
    ...atomicOptions,
    cwd,
    ...(hasAgentDirOverride ? { agentDir } : {}),
    settingsManager,
    resourceLoader,
  };
}

function clonePackageSource(source: PackageSource): PackageSource {
  if (typeof source === "string") return source;
  return {
    source: source.source,
    ...(source.extensions === undefined ? {} : { extensions: [...source.extensions] }),
    ...(source.skills === undefined ? {} : { skills: [...source.skills] }),
    ...(source.prompts === undefined ? {} : { prompts: [...source.prompts] }),
    ...(source.themes === undefined ? {} : { themes: [...source.themes] }),
    ...(source.workflows === undefined ? {} : { workflows: [...source.workflows] }),
  };
}

function packageSourcePath(source: PackageSource): string {
  return typeof source === "string" ? source : source.source;
}

function disablePackageExtensions(source: PackageSource): PackageSource {
  if (typeof source === "string") return { source, extensions: [] };
  return { ...source, extensions: [] };
}

function stageBuiltinPackagePaths(paths: readonly PackageSource[]): PackageSource[] {
  // Workflow stages are child AgentSessions owned by the workflow extension.
  // Loading the workflows extension again inside that child session replays its
  // `session_start` lifecycle and clears/kills the parent workflow store. Keep
  // the workflows package itself so its bundled skills/prompts/resources remain
  // available, but disable only its extension entry for stage sessions.
  return paths.map((path) => {
    const cloned = clonePackageSource(path);
    return basename(packageSourcePath(cloned)) === "workflows"
      ? disablePackageExtensions(cloned)
      : cloned;
  });
}

const SUBAGENT_CHILD_EXTENSION_ENV_KEYS = [
  "ATOMIC_SUBAGENT_CHILD",
  "ATOMIC_SUBAGENT_FANOUT_CHILD",
  "PI_SUBAGENT_CHILD",
  "PI_SUBAGENT_FANOUT_CHILD",
] as const;

let workflowStageResourceReloadQueue: Promise<void> = Promise.resolve();

async function reloadWorkflowStageResources(resourceLoader: PiSdkResourceLoader): Promise<void> {
  const queuedReload = workflowStageResourceReloadQueue.then(() =>
    reloadWorkflowStageResourcesWithEnvIsolation(resourceLoader),
  );
  workflowStageResourceReloadQueue = queuedReload.catch(() => undefined);
  return queuedReload;
}

async function reloadWorkflowStageResourcesWithEnvIsolation(resourceLoader: PiSdkResourceLoader): Promise<void> {
  // Workflow stage sessions are already governed by an orchestration context
  // that disables recursive workflow tools and caps nested subagent depth. When
  // a workflow itself runs inside a subagent child process, inherited subagent
  // child env flags would otherwise make the bundled subagents extension skip
  // registering its `subagent` tool before the stage session exists. Isolate
  // extension discovery from those parent-process flags so an explicit
  // `tools: ["subagent"]` allowlist works the same in workflow stages everywhere.
  // The isolation mutates process-global env, so serialize the full
  // save/delete/reload/restore section. Without this queue, overlapping workflow
  // stage session creation can snapshot an already-cleared env and restore that
  // stale snapshot after another reload restores the real parent values.
  const previousValues = new Map<string, string | undefined>();
  for (const key of SUBAGENT_CHILD_EXTENSION_ENV_KEYS) {
    previousValues.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    await resourceLoader.reload();
  } finally {
    for (const key of SUBAGENT_CHILD_EXTENSION_ENV_KEYS) {
      const previousValue = previousValues.get(key);
      if (previousValue === undefined) delete process.env[key];
      else process.env[key] = previousValue;
    }
  }
}
