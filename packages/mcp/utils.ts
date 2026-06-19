import type { ExtensionAPI } from "@bastani/atomic";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { McpConfig, ServerEntry } from "./types.ts";

async function execOpen(pi: ExtensionAPI, target: string, browser?: string) {
  const os = platform();

  if (os === "darwin") {
    return browser ? pi.exec("open", ["-a", browser, target]) : pi.exec("open", [target]);
  }
  if (os === "win32") {
    return browser
      ? pi.exec("cmd", ["/c", "start", "", browser, target])
      : pi.exec("cmd", ["/c", "start", "", target]);
  }
  return browser ? pi.exec(browser, [target]) : pi.exec("xdg-open", [target]);
}

export async function openUrl(pi: ExtensionAPI, url: string, browser?: string): Promise<void> {
  const result = await execOpen(pi, url, browser);
  if (result.code !== 0) {
    throw new Error(result.stderr || `Failed to open browser (exit code ${result.code})`);
  }
}

export async function openPath(pi: ExtensionAPI, targetPath: string): Promise<void> {
  const result = await execOpen(pi, targetPath);
  if (result.code !== 0) {
    throw new Error(result.stderr || `Failed to open path (exit code ${result.code})`);
  }
}

export async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array(Math.min(limit, items.length)).fill(null).map(() => worker());
  await Promise.all(workers);
  return results;
}

export function getConfigPathFromArgv(): string | undefined {
  const idx = process.argv.indexOf("--mcp-config");
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

export function interpolateEnvVars(value: string): string {
  return value
    .replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
    .replace(/\$env:(\w+)/g, (_, name) => process.env[name] ?? "");
}

export function interpolateEnvRecord(values: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!values) return undefined;

  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    resolved[key] = interpolateEnvVars(value);
  }
  return resolved;
}

export function resolveConfigPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  const resolved = interpolateEnvVars(value);
  if (resolved === "~") return homedir();
  if (resolved.startsWith("~/") || resolved.startsWith("~\\")) {
    return join(homedir(), resolved.slice(2));
  }
  return resolved;
}

export function resolveBearerToken(definition: Pick<ServerEntry, "bearerToken" | "bearerTokenEnv">): string | undefined {
  if (definition.bearerToken !== undefined) {
    return interpolateEnvVars(definition.bearerToken);
  }
  return definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined;
}

export function truncateAtWord(text: string, target: number): string {
  if (!text || text.length <= target) return text;

  const truncated = text.slice(0, target);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace > target * 0.6) {
    return truncated.slice(0, lastSpace) + "...";
  }

  return truncated + "...";
}

export function formatAuthRequiredMessage(
  config: Pick<McpConfig, "settings">,
  serverName: string,
  defaultMessage: string,
): string {
  const template = config.settings?.authRequiredMessage;
  return template ? template.replaceAll("${server}", serverName) : defaultMessage;
}

/**
 * Extract the adapter-owned UI stream mode from tool metadata.
 */
export function extractToolUiStreamMode(toolMeta: Record<string, unknown> | undefined): "eager" | "stream-first" | undefined {
  const uiMeta = toolMeta?.ui;
  if (!uiMeta || typeof uiMeta !== "object") return undefined;
  const streamMode = (uiMeta as Record<string, unknown>)["pi-mcp-adapter.streamMode"];
  if (streamMode === "eager" || streamMode === "stream-first") {
    return streamMode;
  }
  return undefined;
}

/**
 * Reconstruct flattened tool-call arguments into proper nested arrays/objects.
 *
 * Some upstream providers — notably GitHub Copilot Gemini models proxied through
 * Google's GenAI API — serialize array/object function-call arguments as
 * flattened, indexed keys on the wire. For example a tool called with
 * `{ keywords: ["a", "b"] }` arrives as `{ "keywords[0]": "a", "keywords[1]": "b" }`,
 * which an MCP server then rejects as invalid arguments.
 *
 * This normalizer runs at the MCP `callTool` boundary so arguments are correct
 * regardless of how the model/provider serialized them. It is provider-agnostic
 * and **self-gating**: it is a no-op unless at least one bracket-indexed key
 * (`name[<digit>]`) is present, so well-formed arguments pass through untouched
 * (including arguments already normalized upstream by the host runtime).
 */
export function unflattenToolArguments(
  args: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (args === null || args === undefined) return {};
  const keys = Object.keys(args);
  if (!keys.some((key) => /\[\d+\]/.test(key))) return args;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const segments = parseFlattenedArgPath(key);
    if (!segments) {
      result[key] = value;
      continue;
    }
    assignFlattenedArgPath(result, segments, value);
  }
  return compactSparseArrayHoles(result) as Record<string, unknown>;
}

/** Parse `a.b[0].c` into `["a","b",0,"c"]`; returns undefined for a plain key. */
function parseFlattenedArgPath(key: string): Array<string | number> | undefined {
  if (!/[.[]/.test(key)) return undefined;
  const segments: Array<string | number> = [];
  let current = "";
  let index = 0;
  const flush = () => {
    if (current !== "") {
      segments.push(current);
      current = "";
    }
  };
  while (index < key.length) {
    const char = key[index];
    if (char === ".") {
      flush();
      index += 1;
    } else if (char === "[") {
      flush();
      const end = key.indexOf("]", index);
      if (end === -1) return undefined;
      const inner = key.slice(index + 1, end);
      const numeric = Number(inner);
      if (inner.trim() !== "" && Number.isInteger(numeric) && numeric >= 0) {
        segments.push(numeric);
      } else {
        segments.push(inner.replace(/^["']|["']$/g, ""));
      }
      index = end + 1;
    } else {
      current += char;
      index += 1;
    }
  }
  flush();
  return segments.length > 0 ? segments : undefined;
}

function assignFlattenedArgPath(
  root: Record<string, unknown>,
  segments: Array<string | number>,
  value: unknown,
): void {
  let node: Record<string | number, unknown> = root as Record<string | number, unknown>;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (segment === "__proto__" || segment === "constructor" || segment === "prototype") {
      continue;
    }
    const nextIsIndex = typeof segments[i + 1] === "number";
    const existing = node[segment];
    if (existing === null || existing === undefined || typeof existing !== "object") {
      node[segment] = nextIsIndex ? [] : {};
    }
    node = node[segment] as Record<string | number, unknown>;
  }
  node[segments[segments.length - 1]] = value;
}

function compactSparseArrayHoles(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((entry) => entry !== undefined).map((entry) => compactSparseArrayHoles(entry));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = compactSparseArrayHoles(entry);
    return out;
  }
  return value;
}
