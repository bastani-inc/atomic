export type AgentType = "claude" | "copilot" | "opencode";
export type Source = "local" | "global" | "builtin";
export type Phase = "pick" | "prompt";
export type FieldType = "text" | "string" | "enum";

export interface PickerTheme {
  background: string;
  backgroundPanel: string;
  backgroundElement: string;
  surface: string;
  text: string;
  textMuted: string;
  textDim: string;
  primary: string;
  success: string;
  error: string;
  warning: string;
  info: string;
  mauve: string;
  border: string;
  borderActive: string;
}

export interface WorkflowInput {
  name: string;
  type: FieldType;
  required?: boolean;
  description?: string;
  placeholder?: string;
  default?: string;
  values?: string[];
}

export interface Workflow {
  name: string;
  description: string;
  source: Source;
  agents: AgentType[];
  inputs?: WorkflowInput[];
}

export interface ListEntry {
  workflow: Workflow;
  section: Source;
}

export interface ListRow {
  kind: "section" | "entry";
  source?: Source;
  entry?: ListEntry;
}

export interface KeyHint {
  key: string;
  label: string;
  dim?: boolean;
}
