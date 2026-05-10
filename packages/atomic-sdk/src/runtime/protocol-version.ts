import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

export function getProtocolVersion(): string {
  if (cached !== null) return cached;
  const pkgUrl = import.meta.resolve("@bastani/atomic-sdk/package.json");
  const protoPath = join(dirname(fileURLToPath(pkgUrl)), "sdk-protocol-version.json");
  const parsed = JSON.parse(readFileSync(protoPath, "utf8")) as { protocolVersion: string };
  cached = parsed.protocolVersion;
  return cached;
}
