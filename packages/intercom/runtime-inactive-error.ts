const INTERCOM_RUNTIME_INACTIVE_HINT =
	"The session's Intercom runtime ended (the session reloaded or shut down); a new Intercom runtime connects on its next use.";

/** Intercom was asked for a connection after the Intercom runtime that owned it ended (the session reloaded or shut down). */
export class IntercomRuntimeInactiveError extends Error {
	override readonly name = "IntercomRuntimeInactiveError" as const;
	readonly code = "intercom_unavailable" as const;
	readonly hint = INTERCOM_RUNTIME_INACTIVE_HINT;

	constructor(options?: ErrorOptions) {
		super(
			`Intercom runtime no longer active: its session context ended (intercom_unavailable). ${INTERCOM_RUNTIME_INACTIVE_HINT}`,
			options,
		);
	}
}

export function isIntercomRuntimeInactiveError(value: unknown): value is IntercomRuntimeInactiveError {
	if (value instanceof IntercomRuntimeInactiveError) return true;
	if (typeof value !== "object" || value === null) return false;
	const { name, code } = value as { readonly name?: unknown; readonly code?: unknown };
	return name === "IntercomRuntimeInactiveError" && code === "intercom_unavailable";
}
