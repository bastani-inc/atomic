// Preload only in the coalescing test's child, leaving its shipped worker bundle unchanged.
const setInterval = globalThis.setInterval;
globalThis.setInterval = (callback, milliseconds, ...args) =>
	// WORKER_ACTIVITY_INTERVAL_MS is 1 s. Gate only that independent publication source;
	// the 250 ms lease/usage heartbeat must continue to run normally.
	setInterval(milliseconds === 1_000 ? () => {} : callback, milliseconds, ...args);

const send = process.send.bind(process);
const pending = new Set();
process.send = (message, ...args) => {
	if (message.kind === "activity") pending.add(message.id);
	return send(message, ...args);
};
process.on("message", (message) => {
	if (!pending.delete(message.id)) return;
	// The worker resumes its publication promise in microtasks after this acknowledgement.
	// A serial backlog sends its next request before this turn ends, so it remains pending.
	setImmediate(() => {
		if (pending.size === 0) send({ kind: "activity-drained" });
	});
});
