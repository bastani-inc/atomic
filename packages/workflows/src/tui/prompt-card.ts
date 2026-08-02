/**
 * HIL prompt card public facade.
 *
 * Implementation is split into sibling modules to keep each source file under
 * the repository's file-length limit while preserving existing imports.
 */

export { handlePromptCardInput, isPromptEscapeInput } from "./prompt-card-input.js";
export type { PromptCardIdentity, PromptCardRenderOpts } from "./prompt-card-render.js";
export { renderPromptCard } from "./prompt-card-render.js";
export type { PromptCardAction, PromptCardState } from "./prompt-card-state.js";
export { createPromptCardState, defaultResponseFor } from "./prompt-card-state.js";
