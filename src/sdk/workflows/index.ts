/**
 * @bastani/atomic/workflows — workflow SDK barrel.
 *
 * Mirrors the root barrel for the historical `/workflows` import path.
 * Provider-specific helpers (validators, native SDK type re-exports) and
 * the validation warning type live here so consumers don't have to drill
 * into provider modules directly.
 *
 * Tmux helpers and other runtime utilities are intentionally NOT
 * re-exported — they are private to the SDK and the atomic CLI.
 */

// ─── Authoring ──────────────────────────────────────────────────────────────
export { defineWorkflow, WorkflowBuilder } from "../define-workflow.ts";
export { createRegistry } from "../registry.ts";
export type { Registry } from "../registry.ts";

// ─── Errors ─────────────────────────────────────────────────────────────────
export {
  MissingDependencyError,
  WorkflowNotCompiledError,
  InvalidWorkflowError,
} from "../errors.ts";

// ─── Shared types ───────────────────────────────────────────────────────────
export type {
  AgentType,
  Transcript,
  SavedMessage,
  SaveTranscript,
  SessionContext,
  SessionRef,
  SessionHandle,
  SessionRunOptions,
  ValidationWarning,
  WorkflowContext,
  WorkflowOptions,
  WorkflowDefinition,
  WorkflowInput,
  WorkflowInputType,
  StageClientOptions,
  StageSessionOptions,
  ProviderClient,
  ProviderSession,
  CopilotClient,
  CopilotClientOptions,
  CopilotSession,
  CopilotSessionConfig,
  OpencodeClient,
  OpencodeSession,
  ClaudeClientWrapper,
  ClaudeSessionWrapper,
} from "../types.ts";

// ─── Native SDK message types ──────────────────────────────────────────────
export type { SessionEvent as CopilotSessionEvent } from "@github/copilot-sdk";
export type { SessionPromptResponse as OpenCodePromptResponse } from "@opencode-ai/sdk/v2";
export type { SessionMessage as ClaudeSessionMessage } from "@anthropic-ai/claude-agent-sdk";

// ─── Provider helpers ──────────────────────────────────────────────────────
export {
  createClaudeSession,
  claudeQuery,
  clearClaudeSession,
  extractAssistantText,
  validateClaudeWorkflow,
} from "../providers/claude.ts";
export type {
  ClaudeSessionOptions,
  ClaudeQueryOptions,
} from "../providers/claude.ts";

export { validateCopilotWorkflow } from "../providers/copilot.ts";
export { validateOpenCodeWorkflow } from "../providers/opencode.ts";

// ─── Metadata accessors ────────────────────────────────────────────────────
export {
  getName,
  getDescription,
  getAgent,
  getInputSchema,
  getSource,
  getMinSDKVersion,
} from "../primitives/metadata.ts";

// ─── Registry iteration ────────────────────────────────────────────────────
export { listWorkflows, getWorkflow } from "../index.ts";

// ─── Input validation ──────────────────────────────────────────────────────
export { validateInputs } from "../primitives/inputs.ts";
export type { ResolvedInputs } from "../primitives/inputs.ts";

// ─── Run a workflow ────────────────────────────────────────────────────────
export { runWorkflow } from "../primitives/run.ts";
export type {
  RunWorkflowOptions,
  RunWorkflowResult,
} from "../primitives/run.ts";

// ─── Session management ────────────────────────────────────────────────────
export {
  listSessions,
  getSession,
  stopSession,
  attachSession,
  getSessionStatus,
  getSessionTranscript,
} from "../primitives/sessions.ts";
export type {
  SessionInfo,
  SessionScope,
  StatusSnapshot,
  ListSessionsOptions,
} from "../primitives/sessions.ts";
