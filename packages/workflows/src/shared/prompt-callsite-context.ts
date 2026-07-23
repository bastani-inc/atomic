import { AsyncLocalStorage } from "node:async_hooks";

const promptCallerStacks = new AsyncLocalStorage<string>();

/** Preserve the workflow-author stack across durable writes before a prompt delegates. */
export function withPromptCallerStack<T>(stack: string | undefined, delegate: () => T): T {
  if (stack === undefined) return delegate();
  return promptCallerStacks.run(stack, delegate);
}

export function currentPromptCallerStack(): string | undefined {
  return promptCallerStacks.getStore();
}
