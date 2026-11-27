import type { AssistantMessage } from "@bastani/atomic-ai";

/** Keep retry identity in memory, outside the saved transcript and provider payload. */
export const assistantRequestIds = new WeakMap<AssistantMessage, string>();
