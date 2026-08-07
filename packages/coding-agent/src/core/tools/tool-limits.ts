/**
 * Constants related to tool result size limits.
 *
 * These mirror the conventions used by the upstream Claude Code tool-result
 * storage mechanism (mehmoodosman/claude-code, `src/constants/toolLimits.ts`):
 * oversized tool results are persisted to disk and replaced in model context
 * with a short preview that references the saved file.
 */

/**
 * Default maximum size in characters for tool results before they get persisted
 * to disk. When exceeded, the result is saved to a file and the model receives
 * a preview with the file path instead of the full content.
 *
 * Individual tools may declare a lower cap, but this constant acts as a
 * system-wide ceiling regardless of what tools declare.
 */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;

/** Subdirectory (within the session directory) for persisted tool results. */
export const TOOL_RESULTS_SUBDIR = "tool-results";

/** XML tags wrapping a persisted-output preview message. */
export const PERSISTED_OUTPUT_TAG = "<persisted-output>";
export const PERSISTED_OUTPUT_CLOSING_TAG = "</persisted-output>";

/** Preview size in bytes shown inline in the persisted-output message. */
export const PREVIEW_SIZE_BYTES = 2000;

/**
 * Hard cap on the number of bytes any single persisted tool-output file may hold.
 *
 * Persisted output exists so the model can read back what did not fit in context;
 * past this size the file is no longer a useful artifact, only a way to fill the
 * disk. Writers stop at the cap and append {@link PERSISTED_OUTPUT_TRUNCATION_MARKER}
 * so the total file size never exceeds it.
 */
export const MAX_PERSISTED_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Appended in place of the content dropped at {@link MAX_PERSISTED_OUTPUT_BYTES}. */
export const PERSISTED_OUTPUT_TRUNCATION_MARKER = `\n[Output truncated: persisted-output cap of ${MAX_PERSISTED_OUTPUT_BYTES} bytes reached]\n`;
