/**
 * Probe script for the codegraph-contract.test.ts isolation workaround.
 *
 * Run in a subprocess (Bun.spawn) so it loads @colbymchenry/codegraph in a
 * fresh module registry, bypassing any mock.module leaks from preflight tests.
 *
 * Output: JSON { statics: string[], prototype: string[] }
 */
import CodeGraph from "@colbymchenry/codegraph";

const cgAsRecord = CodeGraph as unknown as Record<string, unknown>;
const statics = Object.getOwnPropertyNames(CodeGraph).filter(
  (k) => typeof cgAsRecord[k] === "function"
);
const protoAsRecord = CodeGraph.prototype as unknown as Record<string, unknown>;
const proto = Object.getOwnPropertyNames(CodeGraph.prototype).filter(
  (k) => typeof protoAsRecord[k] === "function"
);

process.stdout.write(JSON.stringify({ statics, prototype: proto }));
