// Loaded with `node --import` or `bun --preload` into a node's process to skew its wall clock by ADT_CLOCK_SKEW_MS
// milliseconds, as a machine whose clock drifted would have it. Only `Date` moves: timers and the monotonic clock
// (`performance.now()`) keep real time, as they do on such a machine.
const skewMs = Number(process.env.ADT_CLOCK_SKEW_MS ?? "0");
if (Number.isFinite(skewMs) && skewMs !== 0) {
	const RealDate = Date;
	class SkewedDate extends RealDate {
		constructor(...args) {
			if (args.length === 0) super(RealDate.now() + skewMs);
			else super(...args);
		}
		static now() {
			return RealDate.now() + skewMs;
		}
	}
	globalThis.Date = SkewedDate;
}
