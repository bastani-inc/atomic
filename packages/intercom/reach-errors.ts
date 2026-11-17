/**
 * #5352: the broker a session with a reach policy found does not enforce reach policies (it is older than this
 * version, and replacing it failed), so the session does not register with it. Run `atomic intercom restart` to
 * replace the broker.
 */
export class IntercomReachUnsupportedError extends Error {
	readonly code = "reach_policy_unsupported";
	constructor() {
		super(
			"This Intercom broker does not enforce reach policies, so this session is not registered with it. Run `atomic intercom restart` to replace the broker.",
		);
		this.name = "IntercomReachUnsupportedError";
	}
}

/** Whether `error` is an {@link IntercomReachUnsupportedError}. */
export function isIntercomReachUnsupportedError(error: unknown): error is IntercomReachUnsupportedError {
	return error instanceof IntercomReachUnsupportedError;
}
