import type { JsonWireValue } from "./framing.js";

/** The Intercom wire protocol versions a broker accepts, or a client speaks, inclusive at both ends. */
export interface BrokerProtocolRange {
	readonly min: number;
	readonly max: number;
}

/**
 * Protocol 1 is the wire of Atomic 0.9.71 and earlier: plain `register`, no released-children frames. Protocol 2 adds
 * `register_verified`, the released-children frames and the broker frames that answer them, and `peer_rebound`.
 */
export const BROKER_PROTOCOL: BrokerProtocolRange = { min: 1, max: 2 };

/** The range of a broker that answers `broker_status` without advertising one, or a client that registers without one. */
export const LEGACY_BROKER_PROTOCOL: BrokerProtocolRange = { min: 1, max: 1 };

/** The first protocol with `register_verified`, the released-children frames and `peer_rebound`. */
export const VERIFIED_REGISTRATION_PROTOCOL = 2;

/**
 * How a session of `own` treats a running broker of `running`:
 * - `upgrade`: the running broker is older and everything it accepts this version's broker accepts too, so a successor
 *   started from this version keeps every connected session working.
 * - `incompatible`: the ranges share no version; the running broker is left alone.
 * - `compatible`: the ranges overlap and the running broker is not replaceable without dropping a version it accepts.
 */
export type BrokerProtocolDecision = "upgrade" | "incompatible" | "compatible";

export function decideBrokerProtocol(own: BrokerProtocolRange, running: BrokerProtocolRange): BrokerProtocolDecision {
	if (own.min > running.max || running.min > own.max) return "incompatible";
	if (running.max < own.max && own.min <= running.min) return "upgrade";
	return "compatible";
}

/** The newest version both ranges speak, or `undefined` when they share none. */
export function agreedProtocol(own: BrokerProtocolRange, running: BrokerProtocolRange): number | undefined {
	const agreed = Math.min(own.max, running.max);
	return agreed < Math.max(own.min, running.min) ? undefined : agreed;
}

function isProtocolVersion(value: JsonWireValue | undefined): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Whether a wire value is a protocol range: positive integers with `min <= max`. */
export function isBrokerProtocolRange(value: JsonWireValue | undefined): value is { min: number; max: number } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return isProtocolVersion(value.min) && isProtocolVersion(value.max) && value.min <= value.max;
}

/** A validated protocol range, or {@link LEGACY_BROKER_PROTOCOL} when an older peer sent none. */
export function protocolRangeOf(value: BrokerProtocolRange | undefined): BrokerProtocolRange {
	return value === undefined ? LEGACY_BROKER_PROTOCOL : { min: value.min, max: value.max };
}
