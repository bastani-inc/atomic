/** Defers run-owned resource cleanup until every detached child closes. */
export function createDetachedCleanupBarrier(onReady: () => void): {
  readonly recover: (index: number) => void;
  readonly defer: (indices: readonly number[]) => boolean;
} {
  const recovered = new Set<number>();
  let expected: ReadonlySet<number> | undefined;
  let cleaned = false;
  const finishIfReady = () => {
    if (cleaned || !expected || ![...expected].every((index) => recovered.has(index))) return;
    cleaned = true;
    onReady();
  };
  return {
    recover(index) {
      recovered.add(index);
      finishIfReady();
    },
    defer(indices) {
      if (indices.length === 0) return false;
      expected = new Set(indices);
      finishIfReady();
      return true;
    },
  };
}
