
import { mock } from "bun:test";
import * as originalFs from "node:fs";
const originalAppendFileSync = originalFs.appendFileSync.bind(originalFs);

const markers = ["partial-fault-later", "partial-fault-batch"] as const;
const fired = new Set<string>();

mock.module("fs", () => ({
  ...originalFs,
  appendFileSync(
    path: Parameters<typeof originalFs.appendFileSync>[0],
    data: Parameters<typeof originalFs.appendFileSync>[1],
    options?: Parameters<typeof originalFs.appendFileSync>[2],
  ): void {
    const text = typeof data === "string" ? data : Buffer.from(data).toString();
    const marker = markers.find((candidate) => text.includes(candidate) && !fired.has(candidate));
    if (marker === undefined) {
      originalAppendFileSync(path, data, options);
      return;
    }
    fired.add(marker);
    const prefixLength = text.indexOf(marker) + Math.max(1, Math.floor(marker.length / 2));
    originalAppendFileSync(path, text.slice(0, prefixLength), options);
    throw new Error(`fault after partial physical append: ${marker}`);
  },
}));
