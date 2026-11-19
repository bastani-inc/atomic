import { AsyncLocalStorage } from "node:async_hooks";

/** A tool that follows its own listing cursors keeps them apart from other calls, without changing their URLs. */
export const historySearchScope = new AsyncLocalStorage<object>();
