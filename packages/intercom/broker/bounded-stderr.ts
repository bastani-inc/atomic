import { format } from "node:util";

/**
 * Physical cap for `broker.log`, enforced inside the broker process.
 *
 * The parent hands the detached broker an already-open descriptor and then exits; nothing on
 * the parent side can bound what the child appends afterwards. Truncating the file from outside
 * does not help either: a POSIX `O_APPEND` descriptor simply writes at the new end of file, and
 * on Windows the inherited append handle has no truncate right. So the limit is applied where
 * the bytes originate, inside the broker.
 */
export const BROKER_LOG_MAX_BYTES = 8 * 1024;

interface WritableLike {
  write(chunk: string | Uint8Array, ...rest: never[]): boolean;
}

interface ConsoleLike {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}
interface FatalHandlerHost {
  on(event: "uncaughtException" | "unhandledRejection", listener: (value: unknown) => void): unknown;
  off?(event: "uncaughtException" | "unhandledRejection", listener: (value: unknown) => void): unknown;
  exit(code?: number): never;
}

export interface BoundedStderrOptions {
  readonly maxBytes?: number;
  readonly stream?: WritableLike;
  readonly console?: ConsoleLike;
  /** Host for the fatal-error handlers. Pass `null` to skip installing them. */
  readonly process?: FatalHandlerHost | null;
}

export interface BoundedStderrHandle {
  /** Bytes accepted so far, for tests and diagnostics. */
  readonly writtenBytes: () => number;
  /** Bounded writer, for callers that must report something without breaking the cap. */
  readonly write: (text: string) => void;
  /** Undo every patch this installation made. */
  readonly restore: () => void;
}

/**
 * Cap everything this process can append to its stderr.
 *
 * Three routes reach the log and each needs its own patch:
 *
 * 1. `process.stderr.write` — the stream itself.
 * 2. `console.error` / `console.warn` — Bun's console is native and writes to the file
 *    descriptor directly, so patching the stream alone leaves it uncapped. Measured: a Bun
 *    child with only the stream patched wrote 1001 bytes against a 100-byte cap.
 * 3. Node's and Bun's default fatal printing for an uncaught exception or an unhandled
 *    rejection, which does not go through the stream either. Measured under Node: a fatal
 *    error produced a 20 KiB log despite the stream patch.
 *
 * Bytes are counted rather than characters, only the portion that still fits is forwarded, and
 * writes past the cap report success and run their callbacks without writing. No "limit
 * reached" notice is emitted: such a notice would itself have to exceed the cap it announces.
 *
 * A native addon writing straight to file descriptor 2, or a child process of the broker, would
 * bypass this. The broker's own module graph contains neither.
 */
export function installBoundedStderr(options: BoundedStderrOptions = {}): BoundedStderrHandle {
  const maxBytes = options.maxBytes ?? BROKER_LOG_MAX_BYTES;
  const stream: WritableLike = options.stream ?? process.stderr;
  const consoleObject: ConsoleLike = options.console ?? console;
  const fatalHost = options.process === undefined ? (process as unknown as FatalHandlerHost) : options.process;

  const originalWrite = stream.write.bind(stream) as WritableLike["write"];
  const originalError = consoleObject.error.bind(consoleObject);
  const originalWarn = consoleObject.warn.bind(consoleObject);
  let written = 0;

  /** Forward at most the remaining budget; returns whether anything reached the stream. */
  const forward = (buffer: Buffer, callback?: (error?: Error | null) => void): boolean => {
    const remaining = maxBytes - written;
    if (remaining <= 0) {
      callback?.(null);
      return true;
    }
    const slice = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
    written += slice.length;
    return callback
      ? (originalWrite as (chunk: Uint8Array, cb: (error?: Error | null) => void) => boolean)(slice, callback)
      : originalWrite(slice);
  };

  const boundedWrite = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    maybeCallback?: (error?: Error | null) => void,
  ): boolean => {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, encoding ?? "utf-8") : Buffer.from(chunk);
    return forward(buffer, callback);
  };

  const writeText = (text: string): void => {
    forward(Buffer.from(text, "utf-8"));
  };

  // The casts keep the public `write`/`console` signatures intact for callers.
  stream.write = boundedWrite as unknown as WritableLike["write"];
  consoleObject.error = (...args: unknown[]): void => {
    writeText(`${format(...args)}\n`);
  };
  consoleObject.warn = consoleObject.error;

  const onFatal = (value: unknown): void => {
    writeText(`${value instanceof Error ? (value.stack ?? value.message) : format(value)}\n`);
    fatalHost?.exit(1);
  };
  if (fatalHost) {
    fatalHost.on("uncaughtException", onFatal);
    fatalHost.on("unhandledRejection", onFatal);
  }

  return {
    writtenBytes: () => written,
    write: writeText,
    restore: () => {
      stream.write = originalWrite;
      consoleObject.error = originalError;
      consoleObject.warn = originalWarn;
      fatalHost?.off?.("uncaughtException", onFatal);
      fatalHost?.off?.("unhandledRejection", onFatal);
    },
  };
}
