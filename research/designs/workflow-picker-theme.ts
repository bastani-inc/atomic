import type { AgentType, PickerTheme, Source } from "./workflow-picker-types.js";

export const theme: PickerTheme = {
  background: "#1e1e2e",
  backgroundPanel: "#181825",
  backgroundElement: "#11111b",
  surface: "#313244",
  text: "#cdd6f4",
  textMuted: "#a6adc8",
  textDim: "#585b70",
  primary: "#89b4fa",
  success: "#a6e3a1",
  error: "#f38ba8",
  warning: "#f9e2af",
  info: "#89dceb",
  mauve: "#cba6f7",
  border: "#313244",
  borderActive: "#45475a",
};

export const SOURCE_DISPLAY: Record<Source, string> = {
  local: "local",
  global: "global",
  builtin: "builtin",
};

export const SOURCE_DIR: Record<Source, string> = {
  local: ".atomic/workflows",
  global: "~/.atomic/workflows",
  builtin: "built-in",
};

export const SOURCE_COLOR: Record<Source, keyof PickerTheme> = {
  local: "success",
  global: "mauve",
  builtin: "info",
};

export const AGENT_PILL_COLOR: Record<AgentType, keyof PickerTheme> = {
  claude: "warning",
  copilot: "success",
  opencode: "mauve",
};
