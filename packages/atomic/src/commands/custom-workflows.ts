/**
 * Custom workflow loader.
 *
 * Spawns each entry's command with `_emit-workflow-meta`, parses the emitted
 * JSON, and returns a `LoadCustomWorkflowsResult` containing successfully
 * loaded workflows and structured failure records.
 *
 * RFC §5.5 + §5.8.
 */

import { randomBytes } from "node:crypto";
import {
  getGlobalSettingsPath,
  getLocalSettingsPath,
  readAtomicConfigSplit,
  type CustomWorkflowEntry,
} from "@bastani/atomic-sdk/services/config/atomic-config";
import type { AgentType, BrokenWorkflow, ExternalWorkflow, WorkflowInput } from "@bastani/atomic-sdk";
import { listWorkflows } from "@bastani/atomic-sdk";
import { createBuiltinRegistry } from "./builtin-registry.ts";

// ─── Public types ────────────────────────────────────────────────────────────

export interface LoadedWorkflow {
  alias: string;
  origin: "local" | "global";
  workflow: ExternalWorkflow;
}

// Re-export the canonical BrokenWorkflow from atomic-sdk so callers can
// import it from either package without creating a circular dependency.
export type { BrokenWorkflow };

export interface LoadCustomWorkflowsResult {
  loaded: LoadedWorkflow[];
  broken: BrokenWorkflow[];
}

// ─── Emitted meta shape (from the SDK's _emit-workflow-meta handler) ─────────

interface EmittedWorkflowDef {
  name: string;
  description?: string;
  agent: AgentType;
  inputs: WorkflowInput[];
  source: string;
  minSDKVersion: string | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const META_PREFIX = "ATOMIC_WORKFLOW_META: ";
const DEFAULT_TIMEOUT_MS = 5000;
const STDERR_TRUNCATE = 500;
const JSON_TRUNCATE = 200;

function resolveTimeoutMs(): number {
  const raw = process.env.ATOMIC_WORKFLOWS_META_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

// ─── Loader ──────────────────────────────────────────────────────────────────

/**
 * Load custom workflows from a `settings.json` `workflows` map.
 *
 * Spawns each entry's command with `_emit-workflow-meta`, parses the output,
 * and returns loaded + broken workflows. Failures are isolated per-entry (and
 * per-agent for the "declared agent missing" case).
 */
export async function loadCustomWorkflows(
  workflows: Record<string, CustomWorkflowEntry> | undefined,
  origin: "local" | "global",
  settingsPath: string,
): Promise<LoadCustomWorkflowsResult> {
  if (!workflows) return { loaded: [], broken: [] };

  const results = await Promise.all(
    Object.entries(workflows).map(([alias, entry]) =>
      loadOne(alias, entry, origin, settingsPath),
    ),
  );

  return {
    loaded: results.flatMap((r) => r.loaded),
    broken: results.flatMap((r) => r.broken),
  };
}

// ─── Single-entry loader ─────────────────────────────────────────────────────

async function loadOne(
  alias: string,
  entry: CustomWorkflowEntry,
  origin: "local" | "global",
  settingsPath: string,
): Promise<LoadCustomWorkflowsResult> {
  const loaded: LoadedWorkflow[] = [];
  const broken: BrokenWorkflow[] = [];
  const timeoutMs = resolveTimeoutMs();
  const args = entry.args ?? [];

  /**
   * Emit a §5.8 diagnostic to stderr and append a `BrokenWorkflow` to the
   * accumulator. Returns `{ loaded, broken }` so callers can early-return.
   */
  function fail(
    failedAgents: AgentType[],
    reason: string,
    fix: string,
  ): LoadCustomWorkflowsResult {
    process.stderr.write(`[atomic/workflows] ${reason}\n`);
    broken.push({ alias, origin, agents: failedAgents, reason, source: settingsPath, fix });
    return { loaded, broken };
  }

  // ── Spawn ────────────────────────────────────────────────────────────────

  const token = randomBytes(16).toString("hex");
  const argv = [entry.command, ...args, "_emit-workflow-meta", `--dispatch-token=${token}`];

  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(argv, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ATOMIC_HOST: "1", ATOMIC_DISPATCH_TOKEN: token },
    });
  } catch (err) {
    return fail(
      entry.agents,
      spawnErrorMessage(alias, entry.command, err),
      isNotFoundError(err)
        ? `install "${entry.command}" or use an absolute path`
        : "check file permissions and PATH",
    );
  }

  // ── Timeout race ─────────────────────────────────────────────────────────

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill(); } catch { /* ignore kill errors */ }
  }, timeoutMs);

  const [stdoutText, stderrText] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
  ]);

  await child.exited;
  clearTimeout(timer);

  if (timedOut) {
    return fail(
      entry.agents,
      `"${alias}": metadata emission timed out after ${timeoutMs}ms — ensure the third-party CLI invokes hostLocalWorkflows([…]) after compile()`,
      `add 'await hostLocalWorkflows([wf])' after the .compile() call in "${entry.command}" (and verify it imports @bastani/atomic-sdk)`,
    );
  }

  // ── Exit code ────────────────────────────────────────────────────────────

  const exitCode = child.exitCode;
  if (exitCode !== 0) {
    const cmdStr = [entry.command, ...args, "_emit-workflow-meta"].join(" ");
    const capturedStderr = stderrText.slice(0, STDERR_TRUNCATE);
    return fail(
      entry.agents,
      `"${alias}": "${cmdStr}" exited ${exitCode}; stderr: ${capturedStderr}`,
      `check that "${entry.command}" supports _emit-workflow-meta`,
    );
  }

  // ── Parse meta line ───────────────────────────────────────────────────────

  const metaLine = stdoutText.split("\n").find((l) => l.startsWith(META_PREFIX));
  if (!metaLine) {
    return fail(
      entry.agents,
      `"${alias}": expected ATOMIC_WORKFLOW_META line — the third-party CLI may be missing the 'await hostLocalWorkflows([wf])' call after compile() (or it is not importing @bastani/atomic-sdk)`,
      `add 'await hostLocalWorkflows([wf])' after the .compile() call in "${entry.command}"`,
    );
  }

  const jsonStr = metaLine.slice(META_PREFIX.length);
  let emitted: unknown;
  try {
    emitted = JSON.parse(jsonStr);
  } catch (parseErr) {
    const snippet = jsonStr.slice(0, JSON_TRUNCATE);
    return fail(
      entry.agents,
      `"${alias}": failed to parse ATOMIC_WORKFLOW_META JSON — ${String(parseErr)}; offending substring: ${snippet}`,
      `ensure "${entry.command}" emits valid JSON on the ATOMIC_WORKFLOW_META line`,
    );
  }
  if (!Array.isArray(emitted)) {
    return fail(
      entry.agents,
      `"${alias}": ATOMIC_WORKFLOW_META payload must be a JSON array (got ${
        emitted === null ? "null" : typeof emitted
      })`,
      `ensure "${entry.command}" emits a JSON array on the ATOMIC_WORKFLOW_META line`,
    );
  }
  const list = emitted as EmittedWorkflowDef[];

  // ── Match per declared agent ──────────────────────────────────────────────

  for (const declaredAgent of entry.agents) {
    const def = list.find((d) => d.agent === declaredAgent);
    if (!def) {
      fail(
        [declaredAgent],
        `"${alias}/${declaredAgent}": command did not register a workflow for agent "${declaredAgent}"`,
        `add a .for("${declaredAgent}") branch to the workflow in "${entry.command}"`,
      );
      continue;
    }

    loaded.push({
      alias,
      origin,
      workflow: {
        kind: "external",
        name: def.name,
        agent: declaredAgent,
        description: def.description,
        inputs: def.inputs ?? [],
        source: { command: entry.command, args },
      },
    });
  }

  return { loaded, broken };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function readStream(
  stream: ReadableStream<Uint8Array<ArrayBufferLike>> | number | null | undefined,
): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  return new Response(stream as ReadableStream<Uint8Array>).text();
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "ENOENT" || code === "MODULE_NOT_FOUND";
}

function spawnErrorMessage(alias: string, cmd: string, err: unknown): string {
  if (isNotFoundError(err)) {
    return `"${alias}": command "${cmd}" not found on PATH; install it or use an absolute path`;
  }
  const errMsg = err instanceof Error ? err.message : String(err);
  return `"${alias}": ${errMsg}`;
}

// ─── Registry merge ───────────────────────────────────────────────────────────

export interface MergeResult {
  registry: ReturnType<typeof createBuiltinRegistry>;
  brokenList: readonly BrokenWorkflow[];
  brokenIndex: ReadonlyMap<string, BrokenWorkflow>;
  summary: string | null;
}

/**
 * Merge global and local custom workflow results into a builtin registry.
 *
 * Precedence: local > global > builtin.
 * Override events are written to stderr as audit lines.
 * Broken entries are indexed by `${agent}/${alias}`.
 *
 * RFC §5.7.
 */
export function mergeIntoRegistry(
  builtin: ReturnType<typeof createBuiltinRegistry>,
  global: LoadCustomWorkflowsResult,
  local: LoadCustomWorkflowsResult,
): MergeResult {
  // Apply global first, then local — so local entries override on collision.
  const allLoaded: readonly LoadedWorkflow[] = [...global.loaded, ...local.loaded];
  let registry = builtin;
  for (const { workflow, origin } of allLoaded) {
    registry = registry.upsert(workflow, (prior) => {
      const priorKind = prior.kind ?? "builtin";
      process.stderr.write(
        `[atomic/workflows] override: ${workflow.name}/${workflow.agent} (${origin}) > ${priorKind}\n`,
      );
    });
  }

  // TWO healthy sets for RFC §5.7.2 shadow-subtraction (alias ∪ name).
  //
  // Set 1: keyed by `${agent}/${alias}` — covers healthy custom externals
  // where the compiled name happens to differ from the alias used in the
  // broken entry.
  const healthyAliasAgent = new Set<string>();
  for (const { alias, workflow } of allLoaded) {
    healthyAliasAgent.add(`${workflow.agent}/${alias}`);
  }

  // Set 2: keyed by compiled `${agent}/${name}` from the fully-merged
  // registry.  Covers BOTH custom externals AND builtins — `blockIfBroken`
  // looks up by name, so any resolvable name (custom OR builtin) must unmask
  // a colliding broken alias.
  const healthyNameAgent = new Set<string>();
  for (const def of listWorkflows(registry)) {
    healthyNameAgent.add(`${def.agent}/${def.name}`);
  }

  // A broken (agent, alias) pair is shadowed when either healthy set matches.
  function isShadowed(a: AgentType, alias: string): boolean {
    const key = `${a}/${alias}`;
    return healthyAliasAgent.has(key) || healthyNameAgent.has(key);
  }

  // Single pass builds both:
  //   brokenIndex (dispatch gate): un-shadowed (agent, alias) → BrokenWorkflow.
  //   brokenList  (display):       entries whose every agent is shadowed drop
  //                                out; surviving entries narrow to visible agents.
  const allBroken: BrokenWorkflow[] = [...global.broken, ...local.broken];
  const brokenIndex = new Map<string, BrokenWorkflow>();
  const brokenList: BrokenWorkflow[] = [];
  for (const b of allBroken) {
    const visibleAgents = b.agents.filter((a) => !isShadowed(a, b.alias));
    if (visibleAgents.length === 0) continue;
    for (const a of visibleAgents) {
      brokenIndex.set(`${a}/${b.alias}`, b);
    }
    brokenList.push({ ...b, agents: visibleAgents });
  }

  // §5.7.2 invariant: brokenIndex must never expose a key that the healthy
  // registry can resolve. If this fires, shadow-subtraction broke and CLI
  // dispatch would emit a false-positive hard-block. Dev-only guard.
  if (process.env.NODE_ENV !== "production") {
    for (const key of brokenIndex.keys()) {
      const slash = key.indexOf("/");
      const agent = key.slice(0, slash) as AgentType;
      const name = key.slice(slash + 1);
      if (registry.resolve(name, agent) !== undefined) {
        throw new Error(
          `[atomic/workflows] §5.7.2 invariant violated: brokenIndex key "${key}" ` +
            `resolves to a healthy workflow; shadow-subtraction missed a collision`,
        );
      }
    }
  }

  const loadedCount = allLoaded.length;
  const summary =
    loadedCount + brokenList.length > 0
      ? `[atomic/workflows] loaded ${loadedCount} custom workflow(s)` +
        (brokenList.length ? ` (${brokenList.length} skipped — see warnings above)` : "")
      : null;

  return { registry, brokenList, brokenIndex, summary };
}

// ─── Bootstrap (read settings → load → merge) ────────────────────────────────

/**
 * Result of `bootstrapCustomWorkflows`. Extends `MergeResult` with the raw
 * `LoadedWorkflow` list so callers (refresh CLI, telemetry) can render
 * per-entry detail (alias, origin) that isn't preserved on the merged registry.
 *
 * Also includes the resolved settings paths so diagnostics can name the
 * exact file the user must edit to fix a broken entry.
 */
export interface BootstrapResult extends MergeResult {
  loaded: LoadedWorkflow[];
  paths: { global: string; local: string };
}

/**
 * Read global + local `settings.json`, spawn each entry's metadata
 * subprocess, and merge the results into a builtin-seeded registry.
 *
 * Pure data flow — does not mutate the active workflow command. Callers
 * are responsible for invoking `rebuildWorkflowCommand(...)` with the
 * returned `registry` and `brokenIndex` if they need the singleton CLI
 * to reflect the new state.
 */
export async function bootstrapCustomWorkflows(
  projectDir: string = process.cwd(),
): Promise<BootstrapResult> {
  const globalPath = getGlobalSettingsPath();
  const localPath = getLocalSettingsPath(projectDir);

  const { global: globalCfg, local: localCfg } =
    await readAtomicConfigSplit(projectDir);

  const [globalRes, localRes] = await Promise.all([
    loadCustomWorkflows(globalCfg?.workflows, "global", globalPath),
    loadCustomWorkflows(localCfg?.workflows, "local", localPath),
  ]);

  const merge = mergeIntoRegistry(createBuiltinRegistry(), globalRes, localRes);

  return {
    ...merge,
    loaded: [...globalRes.loaded, ...localRes.loaded],
    paths: { global: globalPath, local: localPath },
  };
}
