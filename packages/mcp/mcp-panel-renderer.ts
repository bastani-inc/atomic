import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  fg,
  rainbowProgress,
  type PanelTheme,
  type ServerState,
  type ToolState,
  type VisibleItem,
} from "./mcp-panel-types.ts";

export interface McpPanelRenderContext {
  width: number;
  theme: PanelTheme;
  authOnly: boolean;
  descSearchActive: boolean;
  descQuery: string;
  nameQuery: string;
  noticeLines: string[];
  servers: ServerState[];
  visibleItems: VisibleItem[];
  cursorIndex: number;
  importNotice: string | null;
  authNotice: string | null;
  authInFlight: string | null;
  confirmingDiscard: boolean;
  discardSelected: number;
  dirty: boolean;
  maxVisible: number;
}

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[22m`;
}

function italic(text: string): string {
  return `\x1b[3m${text}\x1b[23m`;
}

function inverse(text: string): string {
  return `\x1b[7m${text}\x1b[27m`;
}

function renderConnectionStatus(context: McpPanelRenderContext, server: ServerState): string {
  const t = context.theme;
  if (context.authInFlight === server.name) return `  ${fg(t.needsAuth, "authenticating")}`;
  if (server.connectionStatus === "needs-auth") return `  ${fg(t.needsAuth, "needs auth")}`;
  if (server.connectionStatus === "connecting") return `  ${fg(t.needsAuth, "connecting")}`;
  if (server.connectionStatus === "failed") return `  ${fg(t.cancel, "failed")}`;
  if (context.authOnly && server.connectionStatus === "connected") return `  ${fg(t.direct, "connected")}`;
  if (context.authOnly) return `  ${fg(t.description, "idle")}`;
  return "";
}

function renderServerRow(context: McpPanelRenderContext, server: ServerState, isCursor: boolean): string {
  const t = context.theme;
  const expandIcon = server.expanded ? "▾" : "▸";
  const prefix = isCursor ? fg(t.selected, expandIcon) : fg(t.border, server.expanded ? expandIcon : "·");
  const nameStr = isCursor ? bold(fg(t.selected, server.name)) : server.name;
  const importLabel = server.source === "import" ? fg(t.description, ` (${server.importKind ?? "import"})`) : "";
  const statusLabel = renderConnectionStatus(context, server);

  if (!server.hasCachedData && !context.authOnly) {
    return `${prefix}   ${nameStr}${importLabel}  ${fg(t.description, "(not cached)")}${statusLabel}`;
  }

  const directCount = server.tools.filter((tool) => tool.isDirect).length;
  const totalCount = server.tools.length;
  let toggleIcon = fg(t.description, "○");
  if (directCount === totalCount && totalCount > 0) {
    toggleIcon = fg(t.direct, "●");
  } else if (directCount > 0) {
    toggleIcon = fg(t.needsAuth, "◐");
  }

  let toolInfo = "";
  if (totalCount > 0) {
    toolInfo = `${directCount}/${totalCount}`;
    if (directCount > 0) {
      const tokens = server.tools.filter((tool) => tool.isDirect).reduce((sum, tool) => sum + tool.estimatedTokens, 0);
      toolInfo += `  ~${tokens.toLocaleString()}`;
    }
    toolInfo = fg(t.description, toolInfo);
  }

  return `${prefix} ${toggleIcon} ${nameStr}${importLabel}  ${toolInfo}${statusLabel}`;
}

function renderToolRow(context: McpPanelRenderContext, tool: ToolState, isCursor: boolean, innerW: number): string {
  const t = context.theme;
  const toggleIcon = tool.isDirect ? fg(t.direct, "●") : fg(t.description, "○");
  const cursor = isCursor ? fg(t.selected, "▸") : " ";
  const nameStr = isCursor ? bold(fg(t.selected, tool.name)) : tool.name;
  const prefixLen = 7 + visibleWidth(tool.name);
  const maxDescLen = Math.max(0, innerW - prefixLen - 8);
  const descStr = maxDescLen > 5 && tool.description
    ? fg(t.description, "— " + truncateToWidth(tool.description, maxDescLen, "…"))
    : "";

  return `  ${cursor} ${toggleIcon} ${nameStr} ${descStr}`;
}

function renderFooterStats(context: McpPanelRenderContext): string {
  const t = context.theme;
  if (context.authOnly) return fg(t.description, "select a server to authenticate");

  const directCount = context.servers.reduce((sum, server) => sum + server.tools.filter((tool) => tool.isDirect).length, 0);
  const totalTokens = context.servers.reduce(
    (sum, server) => sum + server.tools.filter((tool) => tool.isDirect).reduce((tokens, tool) => tokens + tool.estimatedTokens, 0),
    0,
  );
  const stats = directCount > 0 ? `${directCount} direct  ~${totalTokens.toLocaleString()} tokens` : "no direct tools";
  return fg(t.description, stats + (context.dirty ? fg(t.needsAuth, "  (unsaved)") : ""));
}

function renderHints(context: McpPanelRenderContext, innerW: number, row: (content: string) => string): string[] {
  const t = context.theme;
  const hints = context.authOnly
    ? [
        italic("↑↓") + " Navigate",
        italic("⏎") + " Auth",
        italic("CTRL+A") + " Auth",
        italic("Escape") + " Clear/Close",
        italic("CTRL+C") + " Quit",
      ]
    : [
        italic("↑↓") + " Navigate",
        italic("Space") + " Toggle",
        italic("⏎") + " Expand/Auth",
        italic("CTRL+A") + " Auth",
        italic("CTRL+R") + " Reconnect",
        italic("?") + " Desc Search",
        italic("CTRL+S") + " Save",
        italic("Escape") + " Clear/Close",
        italic("CTRL+C") + " Quit",
      ];

  const lines: string[] = [];
  const gap = "  ";
  const gapW = 2;
  const maxW = innerW - 2;
  let curLine = "";
  let curW = 0;
  for (const hint of hints) {
    const hw = visibleWidth(hint);
    const needed = curW === 0 ? hw : gapW + hw;
    if (curW > 0 && curW + needed > maxW) {
      lines.push(row(fg(t.hint, curLine)));
      curLine = hint;
      curW = hw;
    } else {
      curLine += (curW > 0 ? gap : "") + hint;
      curW += needed;
    }
  }
  if (curLine) lines.push(row(fg(t.hint, curLine)));
  return lines;
}

export function renderMcpPanel(context: McpPanelRenderContext): string[] {
  const innerW = context.width - 2;
  const lines: string[] = [];
  const t = context.theme;
  const row = (content: string) =>
    fg(t.border, "│") + truncateToWidth(" " + content, innerW, "…", true) + fg(t.border, "│");
  const emptyRow = () => fg(t.border, "│") + " ".repeat(innerW) + fg(t.border, "│");
  const divider = () => fg(t.border, "├" + "─".repeat(innerW) + "┤");

  const titleText = context.authOnly ? " MCP OAuth " : " MCP Servers ";
  const borderLen = innerW - visibleWidth(titleText);
  const leftB = Math.floor(borderLen / 2);
  const rightB = borderLen - leftB;
  lines.push(fg(t.border, "╭" + "─".repeat(leftB)) + fg(t.title, titleText) + fg(t.border, "─".repeat(rightB) + "╮"));
  lines.push(emptyRow());

  const cursor = fg(t.selected, "│");
  const searchIcon = fg(t.border, "◎");
  if (context.descSearchActive) {
    lines.push(row(`${searchIcon}  ${fg(t.needsAuth, "desc:")} ${context.descQuery}${cursor}`));
  } else if (context.nameQuery) {
    lines.push(row(`${searchIcon}  ${context.nameQuery}${cursor}`));
  } else {
    lines.push(row(`${searchIcon}  ${fg(t.placeholder, italic("search..."))}`));
  }

  lines.push(emptyRow());
  if (context.noticeLines.length > 0) {
    for (const notice of context.noticeLines) lines.push(row(fg(t.hint, italic(notice))));
    lines.push(emptyRow());
  }
  lines.push(divider());

  if (context.servers.length === 0) {
    lines.push(emptyRow());
    lines.push(row(fg(t.hint, italic(context.authOnly ? "No OAuth-capable MCP servers configured." : "No MCP servers configured."))));
    lines.push(emptyRow());
  } else {
    const total = context.visibleItems.length;
    const startIdx = Math.max(0, Math.min(context.cursorIndex - Math.floor(context.maxVisible / 2), total - context.maxVisible));
    const endIdx = Math.min(startIdx + context.maxVisible, total);
    lines.push(emptyRow());

    for (let i = startIdx; i < endIdx; i++) {
      const item = context.visibleItems[i];
      const isCursor = i === context.cursorIndex;
      const server = context.servers[item.serverIndex];
      if (item.type === "server") {
        lines.push(row(renderServerRow(context, server, isCursor)));
      } else if (item.toolIndex !== undefined) {
        lines.push(row(renderToolRow(context, server.tools[item.toolIndex], isCursor, innerW)));
      }
    }

    lines.push(emptyRow());
    if (total > context.maxVisible) {
      const prog = Math.round(((context.cursorIndex + 1) / total) * 10);
      lines.push(row(`${rainbowProgress(prog, 10)}  ${fg(t.hint, `${context.cursorIndex + 1}/${total}`)}`));
      lines.push(emptyRow());
    }
    if (context.importNotice) {
      lines.push(row(fg(t.needsAuth, italic(context.importNotice))));
      lines.push(emptyRow());
    }
    if (context.authNotice) {
      lines.push(row(fg(t.needsAuth, italic(context.authNotice))));
      lines.push(emptyRow());
    }
  }

  lines.push(divider());
  lines.push(emptyRow());
  if (context.confirmingDiscard) {
    const discardBtn = context.discardSelected === 0 ? inverse(bold(fg(t.cancel, "  Discard  "))) : fg(t.hint, "  Discard  ");
    const keepBtn = context.discardSelected === 1 ? inverse(bold(fg(t.confirm, "  Keep  "))) : fg(t.hint, "  Keep  ");
    lines.push(row(`Discard unsaved changes?  ${discardBtn}   ${keepBtn}`));
  } else {
    lines.push(row(renderFooterStats(context)));
  }

  lines.push(emptyRow());
  lines.push(...renderHints(context, innerW, row));
  lines.push(fg(t.border, "╰" + "─".repeat(innerW) + "╯"));
  return lines;
}
