const { Session } = require("node:inspector");

const post = Session.prototype.post;
const clockOriginShiftUs = 1_000_000_000_000;
Session.prototype.post = function (method, ...args) {
	if (method === "Profiler.stop" && typeof args.at(-1) === "function") {
		const callback = args.pop();
		return post.call(this, method, ...args, (error, result) => {
			if (result?.profile) {
				result.profile.startTime += clockOriginShiftUs;
				result.profile.endTime += clockOriginShiftUs;
			}
			callback(error, result);
		});
	}
	return post.call(this, method, ...args);
};
