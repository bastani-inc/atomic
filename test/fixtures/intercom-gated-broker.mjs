// A broker held before it starts (#4727): until its agent directory has been removed, as a broker on a cold machine can
// be, or until the release file exists.
// Usage: node intercom-gated-broker.mjs <marker-path> <release-path> <broker-entrypoint> (Intercom appends the last).
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [markerPath, releasePath] = process.argv.splice(2, 2);
writeFileSync(markerPath, String(process.pid));
while (existsSync(process.env.ATOMIC_CODING_AGENT_DIR) && !existsSync(releasePath)) await delay(10);
// jiti's CLI runs the entrypoint left in argv, as the default broker command does.
const jitiPackage = createRequire(import.meta.url).resolve("jiti/package.json");
await import(pathToFileURL(join(dirname(jitiPackage), "lib", "jiti-cli.mjs")).href);
