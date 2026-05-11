/**
 * Derive graph-specific theme tokens from generic pi theme.
 * cross-ref: spec §5.4.1, v0.x packages/atomic-sdk/src/components/graph-theme.ts
 */

export interface GenericTheme {
  primary?: string;
  secondary?: string;
  background?: string;
  foreground?: string;
  success?: string;
  error?: string;
  warning?: string;
  info?: string;
  border?: string;
  muted?: string;
}

export interface GraphTheme {
  nodeBorder: string;
  nodeRunningBorder: string;
  nodeFailedBorder: string;
  nodeCompletedBorder: string;
  nodePendingBorder: string;
  headerBg: string;
  headerFg: string;
  edgeColor: string;
  focusColor: string;
  switcherBg: string;
  switcherFg: string;
  toastSuccessBg: string;
  toastErrorBg: string;
  toastWarnBg: string;
  toastInfoBg: string;
}

export function deriveGraphTheme(theme: GenericTheme): GraphTheme {
  return {
    nodeBorder: theme.border ?? "#555555",
    nodeRunningBorder: theme.info ?? "#4fc3f7",
    nodeFailedBorder: theme.error ?? "#ef5350",
    nodeCompletedBorder: theme.success ?? "#66bb6a",
    nodePendingBorder: theme.muted ?? "#888888",
    headerBg: theme.primary ?? "#1a237e",
    headerFg: theme.foreground ?? "#ffffff",
    edgeColor: theme.muted ?? "#888888",
    focusColor: theme.primary ?? "#5c6bc0",
    switcherBg: theme.background ?? "#1e1e1e",
    switcherFg: theme.foreground ?? "#ffffff",
    toastSuccessBg: theme.success ?? "#2e7d32",
    toastErrorBg: theme.error ?? "#c62828",
    toastWarnBg: theme.warning ?? "#e65100",
    toastInfoBg: theme.info ?? "#0277bd",
  };
}
