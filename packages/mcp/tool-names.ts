import { createHash } from "node:crypto";
import { formatToolName } from "./types.js";

export function assignToolNames(names: readonly string[], server: string, prefix: "server" | "none" | "short"): Map<string, string> {
 const unique = [...new Set(names)];
 const counts = new Map<string, number>();
 for (const name of unique) {
  const plain = formatToolName(name, server, prefix);
  counts.set(plain, (counts.get(plain) ?? 0) + 1);
 }
 return new Map(unique.map((name) => {
  const plain = formatToolName(name, server, prefix);
  if (plain.length <= 64 && counts.get(plain) === 1) return [name, plain];
  const hash = createHash("sha256").update(`${server}\0${name}`).digest("hex").slice(0, 8);
  return [name, `${plain.slice(0, 55)}_${hash}`];
 }));
}
