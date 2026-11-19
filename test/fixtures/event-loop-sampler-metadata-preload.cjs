const { isMainThread } = require("node:worker_threads");

// Deliver a large debugger script catalog slowly. Only its worker pays this cost; application
// work on the main thread remains unchanged. The diagnostic must not pause that thread before the catalog arrives.
if (!isMainThread) {
	const { Session } = require("node:inspector");
	const on = Session.prototype.on;
	const delayMs = Number(process.env.ATOMIC_TEST_SCRIPT_EVENT_DELAY_MS);
	Session.prototype.on = function (event, listener) {
		if (event !== "Debugger.scriptParsed") return on.call(this, event, listener);
		return on.call(this, event, (...args) => {
			if (String(args[0]?.params?.url).includes("MONITOR_WORKER_EVENT_TAG_")) {
				const until = performance.now() + delayMs;
				while (performance.now() < until) {}
			}
			return listener.apply(this, args);
		});
	};
}
