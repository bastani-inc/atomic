export interface PanelTheme {
  border: string;
  title: string;
  selected: string;
  direct: string;
  needsAuth: string;
  placeholder: string;
  description: string;
  hint: string;
  confirm: string;
  cancel: string;
}

export const DEFAULT_THEME: PanelTheme = {
  border: "2",
  title: "2",
  selected: "36",
  direct: "32",
  needsAuth: "33",
  placeholder: "2;3",
  description: "2",
  hint: "2",
  confirm: "32",
  cancel: "31",
};

export function fg(code: string, text: string): string {
  if (!code) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

const RAINBOW_COLORS = [
  "38;2;178;129;214",
  "38;2;215;135;175",
  "38;2;254;188;56",
  "38;2;228;192;15",
  "38;2;137;210;129",
  "38;2;0;175;175",
  "38;2;23;143;185",
];

export function rainbowProgress(filled: number, total: number): string {
  const dots: string[] = [];
  for (let i = 0; i < total; i++) {
    const color = RAINBOW_COLORS[i % RAINBOW_COLORS.length];
    dots.push(fg(color, i < filled ? "●" : "○"));
  }
  return dots.join(" ");
}

export type ConnectionStatus = "connected" | "idle" | "failed" | "needs-auth" | "connecting";

export interface ToolState {
  name: string;
  description: string;
  isDirect: boolean;
  wasDirect: boolean;
  estimatedTokens: number;
}

export interface ServerState {
  name: string;
  expanded: boolean;
  source: "user" | "project" | "import";
  importKind?: string;
  excludeTools?: string[];
  exposeResources: boolean;
  connectionStatus: ConnectionStatus;
  tools: ToolState[];
  hasCachedData: boolean;
}

export interface VisibleItem {
  type: "server" | "tool";
  serverIndex: number;
  toolIndex?: number;
}

export interface PanelTui {
  requestRender(): void;
}

export interface McpPanelOptions {
  noticeLines?: string[];
  authOnly?: boolean;
}
