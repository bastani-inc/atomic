import type { ReleaseObservation, ReleaseStamp } from "../../../../intercom/broker/released-child-receipts.js";

// Using Subagents without Intercom requires no Intercom import at runtime. Only the two participating
// extensions share these cells; no new property is read from SDK requests, or added to native Errors.
const key = Symbol.for("atomic.intercom/released-child-observations@1");
const registry = globalThis as { [key]?: WeakMap<object, ReleaseObservation> };
export function observeRelease(item: object, childName: string): ReleaseObservation {
	const observation = { childName };
	registry[key] ??= new WeakMap();
	registry[key].set(item, observation);
	return observation;
}

/** A recovery starts a new reporting episode even if the previous episode's broker check is still pending. */
export interface HoldNoticeEpisode {
	readonly taskId: string | undefined;
	told: boolean;
	checks: number;
}
export function holdNoticeEpisode(
	notices: Map<string, HoldNoticeEpisode>,
	name: string,
	taskId: string | undefined,
): HoldNoticeEpisode {
	const current = notices.get(name);
	if (current && current.taskId === taskId) return current;
	const episode = { taskId, told: false, checks: 0 };
	notices.set(name, episode);
	return episode;
}

/** A stamp orders operations only within the same broker lifetime and authenticated owner registration. */
export function newerRelease(refusal: ReleaseStamp, repair: ReleaseStamp): boolean {
	return (
		repair.broker === refusal.broker &&
		repair.owner === refusal.owner &&
		repair.registration === refusal.registration &&
		repair.order > refusal.order
	);
}
