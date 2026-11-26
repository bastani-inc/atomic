/**
 * Refuses a Node.js older than Atomic's floor before the rest of the CLI loads. `cli.ts` imports this module first, so it
 * runs before the modules that would fail on that Node.js.
 */
import { unsupportedNodeVersionMessage } from "./utils/node-version-floor.ts";

const message = unsupportedNodeVersionMessage(process.versions);
if (message !== undefined) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}
