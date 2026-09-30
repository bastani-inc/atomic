import { formatToolCallWithArgs } from "@bastani/atomic";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { findToolByName } from "./tool-metadata.js";
import { getServerPrefix, type McpConfig, type ToolMetadata } from "./types.js";

interface RenderTheme {
  fg: Parameters<typeof formatToolCallWithArgs>[2]["fg"];
  bold?: (text: string) => string;
}

export interface McpCallRenderSource {
  config?: McpConfig;
  toolMetadata?: ReadonlyMap<string, ToolMetadata[]>;
}

function textArg(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function inferServer(tool: string, source: McpCallRenderSource): string | undefined {
  const matches = [...(source.toolMetadata ?? [])]
    .filter(([, metadata]) => findToolByName(metadata, tool))
    .map(([server]) => server);
  if (matches.length > 0) return matches.length === 1 ? matches[0] : undefined;
  const prefixMode = source.config?.settings?.toolPrefix ?? "server";
  const candidates = Object.keys(source.config?.mcpServers ?? {}).filter((server) => {
    const prefix = getServerPrefix(server, prefixMode);
    return prefix.length > 0 && tool.startsWith(`${prefix}_`);
  });
  // Prefixes can collide or overlap. Leave the label unresolved rather than
  // predicting which lazy connection will succeed; rendering never connects.
  return candidates.length === 1 ? candidates[0] : undefined;
}

function redactArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactArguments);
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, /token|secret|password|authorization|api.?key/i.test(key) ? "[redacted]" : redactArguments(entry)]),
  );
  return value;
}

function header(theme: RenderTheme, server: string | undefined, operation: string, args?: Record<string, unknown>, expanded = false): Text {
  const clean = (value: string) => stripTerminalSequences(value).replace(/[\r\n\t]/g, " ");
  if (server && args && Object.keys(args).length > 0) return new Text(formatToolCallWithArgs(
    `MCP${server ? ` ${clean(server)}` : ""} · ${clean(operation)}`,
    redactArguments(args),
    { fg: (name, text) => theme.fg(name, text), bold: (text) => theme.bold?.(text) ?? text },
    expanded,
  ), 0, 0);
  return new Text(
    theme.fg("toolTitle", `MCP${server ? ` ${clean(server)}` : ""}`) + theme.fg("muted", ` · ${clean(operation)}`),
    0, 0,
  );
}

export function renderMcpDirectToolCall(server: string, tool: string, theme: RenderTheme, args?: Record<string, unknown>, expanded = false): Text {
  return header(theme, server, tool, args, expanded);
}

export function renderMcpToolCall(
  args: Record<string, unknown>,
  theme: RenderTheme,
  source: McpCallRenderSource = {},
  expanded = false,
): Text {
  let callArgs = args.args;
  if (typeof callArgs === "string") {
    try { callArgs = JSON.parse(callArgs); } catch { callArgs = { args: callArgs }; }
  }
  const action = textArg(args?.action);
  const tool = textArg(args?.tool);
  const connect = textArg(args?.connect);
  const describe = textArg(args?.describe);
  const server = textArg(args?.server);
  // Match gateway dispatch precedence without changing or performing routing.
  if (action === "ui-messages") return header(theme, undefined, action);
  if (tool) {
    const target = server ?? inferServer(tool, source);
    // An explicit label alone is not a resolved target during cold initialization.
    // Keep its payload private until cached configuration or metadata identifies it.
    const knownTarget = target !== undefined && (
      Object.hasOwn(source.config?.mcpServers ?? {}, target) || source.toolMetadata?.has(target)
    );
    return header(theme, target, tool, knownTarget && typeof callArgs === "object" && callArgs !== null && !Array.isArray(callArgs) ? callArgs as Record<string, unknown> : undefined, expanded);
  }
  if (connect) return header(theme, connect, "connect");
  if (describe) return header(theme, server ?? inferServer(describe, source), `describe ${describe}`);
  if (textArg(args?.search)) return header(theme, server, "search");
  return header(theme, server, server ? "tools" : "status");
}
