export class IntercomReachUnsupportedError extends Error {
	readonly code = "reach_policy_unsupported";
	constructor() {
		super(
			"This Intercom broker does not enforce reach policies, so this session is not registered with it. Run `atomic intercom restart` to replace the broker.",
		);
		this.name = "IntercomReachUnsupportedError";
	}
}

export function isIntercomReachUnsupportedError(error: Error): error is IntercomReachUnsupportedError {
	return error instanceof IntercomReachUnsupportedError;
}
