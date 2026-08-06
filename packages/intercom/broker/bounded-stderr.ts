/**
 * Physical cap for `broker.log`, enforced inside the broker process.
 *
 * The parent hands the detached broker an already-open descriptor and then exits; nothing on
 * the parent side can bound what the child appends afterwards. Truncating the file from outside
 * does not help either: a POSIX `O_APPEND` descriptor simply writes at the new end of file, and
 * on Windows the inherited append handle has no truncate right. So the limit is applied where
 * the bytes originate — the broker's own stderr stream — which covers the direct numeric-FD
 * launch and the Windows `cmd.exe ... 2>>` redirect identically.
 */
export const BROKER_LOG_MAX_BYTES = 8 * 1024;

type StderrWrite = typeof process.stderr.write;

interface BoundedStderrHandle {
  /** Bytes accepted so far, for tests and diagnostics. */
  readonly writtenBytes: () => number;
  /** Restore the original `process.stderr.write`. */
  readonly restore: () => void;
}

/**
 * Cap what this process can append to its stderr.
 *
 * Counts bytes rather than characters, forwards only the portion that still fits, and then
 * swallows the rest while still reporting success so a caller that checks the return value or
 * waits on the callback is never left hanging. It deliberately emits no "limit reached" notice:
 * such a notice would itself have to exceed the cap it announces.
 *
 * A native addon writing straight to file descriptor 2 would bypass this, as would a child
 * process of the broker. The broker's own module graph contains neither.
 */
export function installBoundedStderr(
  maxBytes: number = BROKER_LOG_MAX_BYTES,
  stream: NodeJS.WriteStream = process.stderr,
): BoundedStderrHandle {
  const original: StderrWrite = stream.write.bind(stream) as StderrWrite;
  let written = 0;

  const bounded = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    maybeCallback?: (error?: Error | null) => void,
  ): boolean => {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;

    const buffer = typeof chunk === "string" ? Buffer.from(chunk, encoding ?? "utf-8") : Buffer.from(chunk);
    const remaining = maxBytes - written;

    if (remaining <= 0) {
      callback?.(null);
      return true;
    }

    if (buffer.length <= remaining) {
      written += buffer.length;
      return callback ? original(buffer, callback) : original(buffer);
    }

    written += remaining;
    const truncated = buffer.subarray(0, remaining);
    return callback ? original(truncated, callback) : original(truncated);
  };

  // The cast keeps the public `WriteStream.write` overloads intact for callers.
  stream.write = bounded as unknown as StderrWrite;

  return {
    writtenBytes: () => written,
    restore: () => {
      stream.write = original;
    },
  };
}
