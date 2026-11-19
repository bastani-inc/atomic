const { Session } = require("node:inspector");
const post = Session.prototype.post;
Session.prototype.post = function (method, ...args) {
	if (method === "Profiler.stop" && typeof globalThis.runOnProfileRotation === "function") {
		const run = globalThis.runOnProfileRotation;
		globalThis.runOnProfileRotation = undefined;
		run();
		globalThis.profileRotationObserved = true;
	}
	return post.call(this, method, ...args);
};
