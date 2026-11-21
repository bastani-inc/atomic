// Preload for an Intercom broker in tests: reading the source of the module whose path ends with
// ATOMIC_TEST_SLOW_MODULE stalls this process for ATOMIC_TEST_SLOW_MODULE_MS the first time, as loading that module
// does on a busy machine.
const fs = require("node:fs");

const suffix = process.env.ATOMIC_TEST_SLOW_MODULE;
const stallMs = Number(process.env.ATOMIC_TEST_SLOW_MODULE_MS);
const readFileSync = fs.readFileSync;
let stalled = false;
fs.readFileSync = function (path, ...rest) {
	if (!stalled && suffix && String(path).replaceAll("\\", "/").endsWith(suffix)) {
		stalled = true;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
	}
	return readFileSync.call(this, path, ...rest);
};
