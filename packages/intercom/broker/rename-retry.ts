import { existsSync, renameSync, statSync } from "fs";

const RENAME_RETRY_BUDGET_MS = 2_000;
const RENAME_BACKOFF_START_MS = 10;
const RENAME_BACKOFF_MAX_MS = 100;
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(["EACCES", "EPERM", "EBUSY"]);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

interface RenameRetryOptions {
  readonly signal?: AbortSignal;
  readonly budgetMs?: number;
  readonly platform?: NodeJS.Platform;
}

function destinationDirectoryExists(from: string, to: string): boolean {
  try {
    return statSync(from).isDirectory() && existsSync(to);
  } catch {
    return false;
  }
}

export function renameWithRetry(from: string, to: string, options: RenameRetryOptions = {}): void {
  options.signal?.throwIfAborted();
  if ((options.platform ?? process.platform) !== "win32") return renameSync(from, to);
  const started = performance.now();
  const budgetMs = options.budgetMs ?? RENAME_RETRY_BUDGET_MS;
  let backoff = RENAME_BACKOFF_START_MS;
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      options.signal?.throwIfAborted();
      if (performance.now() - started + backoff > budgetMs || destinationDirectoryExists(from, to)) throw error;
      Atomics.wait(sleeper, 0, 0, backoff);
      backoff = Math.min(backoff + RENAME_BACKOFF_START_MS, RENAME_BACKOFF_MAX_MS);
    }
  }
}
