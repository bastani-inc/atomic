/** Identifies the physical decision, not when a listener forwarded its answer. */
export interface ReleaseStamp {
	readonly broker: string;
	readonly order: number;
	readonly owner: string;
	readonly registration: string;
}
export type VerifyRelease = (childName: string, stamp: ReleaseStamp, signal: AbortSignal) => Promise<boolean>;
export interface ConfirmedRelease {
	readonly stamp: ReleaseStamp;
	readonly verify: WeakRef<VerifyRelease>;
}
export interface ReleaseObservation {
	readonly childName: string;
	refusal?: { readonly error: WeakRef<Error>; readonly stamp: ReleaseStamp };
	repair?: ConfirmedRelease;
}

// A child reservation item or ACK request is its occurrence, even across independently loaded extensions.
// A legacy or opaque forwarder that doesn't preserve that occurrence produces no evidence.
const key = Symbol.for("atomic.intercom/released-child-observations@1");
const registry = globalThis as { [key]?: WeakMap<object, ReleaseObservation> };
export function releaseObservation(item: object): ReleaseObservation | undefined {
	return registry[key]?.get(item);
}
export function forwardReleaseObservation(from: object, to: object): void {
	const observation = releaseObservation(from);
	if (observation) registry[key]?.set(to, observation);
}
