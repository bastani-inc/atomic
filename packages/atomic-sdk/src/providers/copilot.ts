/**
 * Copilot workflow source validation + helpers.
 *
 * Checks that Copilot workflow source files use the runtime-managed
 * `s.client` and `s.session` instead of manual SDK client creation.
 */

import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs";
import { delimiter, join, sep } from "node:path";
import type {
  CopilotClientOptions,
  SessionConfig as CopilotSessionConfig,
} from "@github/copilot-sdk";
import { normalizedTerminalEnv } from "../lib/terminal-env.ts";
import { getCommandPath } from "../services/system/detect.ts";
import { createProviderValidator } from "../types.ts";

const JS_EXT_RE = /\.(js|mjs|cjs)$/i;
const NODE_SHEBANG_RE = /^#!.*\bnode\b/;
const NPM_LOADER_MARKER = "npm-loader.js";
const HEADER_BYTES = 256;

/**
 * Read the first {@link HEADER_BYTES} of a file as a UTF-8 string.
 * Returns `null` on any filesystem error (file missing, not readable, etc.).
 */
function readCandidateHeader(filePath: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(HEADER_BYTES);
    const bytesRead = readSync(fd, buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Resolve symlink chain to final target path.
 * Returns the original path on any filesystem error.
 */
function safeRealpath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

/**
 * Return `true` when `candidate` is a Node.js / npm-loader JavaScript shim
 * that should not be passed to the Copilot SDK as the CLI executable.
 *
 * Filesystem errors for a given candidate are treated as "not a shim" so
 * that the SDK can surface the real error (e.g. permission denied, ENOENT).
 */
export function isCopilotShim(candidate: string): boolean {
  if (JS_EXT_RE.test(candidate)) return true;

  if (candidate.includes(`node_modules${sep}.bin`) || candidate.includes("node_modules/.bin")) {
    const real = safeRealpath(candidate);
    if (JS_EXT_RE.test(real)) return true;
  }

  const header = readCandidateHeader(candidate);
  if (header === null) return false;

  return NODE_SHEBANG_RE.test(header) || header.includes(NPM_LOADER_MARKER);
}

/**
 * Build the subprocess environment for the Copilot CLI process.
 * Normalises locale to UTF-8 and suppresses Node.js deprecation warnings.
 */
export function copilotSubprocessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  return { ...normalizedTerminalEnv(baseEnv), NODE_NO_WARNINGS: "1" };
}

/**
 * Enumerate every existing `cmd` candidate across PATH order.
 */
export function enumeratePathCandidates(cmd: string, pathEnv: string): string[] {
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const results: string[] = [];
  for (const dir of dirs) {
    const full = join(dir, cmd);
    if (existsSync(full)) results.push(full);
  }
  return results;
}

export type CommandPathResolver = (cmd: string) => string | null;

export function resolveCopilotCliPath(
  resolveCommandPath: CommandPathResolver = getCommandPath,
): string | undefined {
  const envPath = process.env["COPILOT_CLI_PATH"];
  if (envPath) return envPath;

  const primary = resolveCommandPath("copilot");
  if (primary === null) return undefined;
  if (!isCopilotShim(primary)) return primary;

  const pathEnv = process.env["PATH"] ?? "";
  const candidates = enumeratePathCandidates("copilot", pathEnv);
  for (const candidate of candidates) {
    if (!isCopilotShim(candidate)) return candidate;
  }

  return undefined;
}

/**
 * Build options suitable for `new CopilotClient(...)`.
 *
 * Includes:
 * - `env` from {@link copilotSubprocessEnv} (UTF-8 locale + `NODE_NO_WARNINGS=1`).
 * - `cliPath` from {@link resolveCopilotCliPath} when resolvable; omitted
 *   otherwise so the SDK falls back to its bundled CLI.
 */
export function copilotSdkLaunchOptions(
  resolveCommandPath: CommandPathResolver = getCommandPath,
): CopilotClientOptions {
  const options: CopilotClientOptions = {
    env: copilotSubprocessEnv(),
  };
  const cliPath = resolveCopilotCliPath(resolveCommandPath);
  if (cliPath !== undefined) {
    options.cliPath = cliPath;
  }
  return options;
}

/**
 * Fold the atomic-managed additional instructions into a caller's
 * `systemMessage` value on `client.createSession`. Behavior:
 *
 *   - **No caller value** → `{ mode: "append", content: extra }`. The
 *     SDK's default mode is append and preserves the SDK persona.
 *   - **Append/customize mode** → concatenate our content to the existing
 *     `content` field (newline-separated when both are present).
 *   - **Replace mode** → leave alone. The caller has explicitly opted out
 *     of SDK-managed sections; silently re-adding the persona-style append
 *     would violate that contract.
 *
 * Exported for unit testing.
 */
export function mergeCopilotSystemMessage(
  existing: CopilotSessionConfig["systemMessage"],
  extra: string,
): CopilotSessionConfig["systemMessage"] {
  if (!extra) return existing;
  if (existing === undefined) {
    return { mode: "append", content: extra };
  }
  if (existing.mode === "replace") return existing;
  const prev = existing.content ?? "";
  const merged = prev ? `${prev}\n\n${extra}` : extra;
  return { ...existing, content: merged };
}

// ---------------------------------------------------------------------------
// Resume adapter
// ---------------------------------------------------------------------------

// TODO(task-4): replace with import from offload-types.ts once it lands
interface OffloadResumeMetadata {
  /** Agent-native session ID to pass to --resume=<id>. */
  agentSessionId: string;
}

/**
 * Build the `copilot` CLI argv fragment needed to resume an offloaded session.
 *
 * Produces: ["--resume=<sessionId>"]
 *
 * Note: Copilot CLI requires `=` syntax (not space-separated) per spec §5.4.
 */
export function buildCopilotResumeArgs(meta: OffloadResumeMetadata): string[] {
  return [`--resume=${meta.agentSessionId}`];
}

/**
 * Validate a Copilot workflow source file for common mistakes.
 */
export const validateCopilotWorkflow = createProviderValidator([
  {
    pattern: /\bnew\s+CopilotClient\b/,
    rule: "copilot/manual-client",
    message:
      "Manual CopilotClient creation detected. Use s.client instead — " +
      "the runtime auto-creates and cleans up the client.",
  },
  {
    pattern: /\bclient\.createSession\b/,
    rule: "copilot/manual-session",
    message:
      "Manual createSession() call detected. Use s.session instead — " +
      "the runtime auto-creates the session. Pass session config as the third arg to ctx.stage().",
  },
]);
