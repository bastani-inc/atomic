"use strict";
/**
 * Preloaded into a broker a test starts (`node --require`): when a timeout of a second or more that the process armed
 * fires, it first writes `[timer-probe <pid>] fired <delay>` to stdout. A test reads from it which window the process
 * asked for, whatever how late a loaded machine ran the timer.
 */
const { promisify } = require("node:util");

const REPORTED_FROM_MS = 1000;
const armTimeout = globalThis.setTimeout;

function setTimeoutReportingWhenFired(callback, delay, ...args) {
	if (typeof callback !== "function" || !(Number(delay) >= REPORTED_FROM_MS)) return armTimeout(callback, delay, ...args);
	return armTimeout(
		function reportFired(...callbackArgs) {
			process.stdout.write(`[timer-probe ${process.pid}] fired ${delay}\n`);
			return callback.apply(this, callbackArgs);
		},
		delay,
		...args,
	);
}
setTimeoutReportingWhenFired[promisify.custom] = armTimeout[promisify.custom];
globalThis.setTimeout = setTimeoutReportingWhenFired;
