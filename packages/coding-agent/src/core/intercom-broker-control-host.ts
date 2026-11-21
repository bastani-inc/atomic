/**
 * What the bundled Intercom package's `broker/control.ts` imports from `@bastani/atomic` (its errors, and the process
 * start reads that tell its broker apart from a later process given the same pid), for loading it outside a
 * bundled build without loading the whole package root again. The classes stay the host's own.
 */
export {
	IntercomBrokerStopTimeoutError,
	IntercomBrokerUpgradeError,
	isIntercomBrokerStopTimeoutError,
} from "./intercom-broker-error.ts";
export { ProjectGroupError } from "./intercom-project-group-error.ts";
export { processStartToken, readProcessCreationTime, readProcessStartToken } from "./process-start-token.js";
