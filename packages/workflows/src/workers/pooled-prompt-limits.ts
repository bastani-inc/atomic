/** Why a `ctx.ui.custom` prompt of a child on a local worker fails (#3996). */
export const POOLED_CUSTOM_PROMPT_UNAVAILABLE =
	"ctx.ui.custom is not available in a child workflow running on a local worker: its component cannot be shown outside the worker. Use ctx.ui.input, confirm, select or editor, or run the child in process.";
