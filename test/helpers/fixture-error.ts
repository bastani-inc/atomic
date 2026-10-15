export interface FixtureError {
	readonly name: string;
	readonly message: string;
	readonly stack?: string;
	readonly code?: string;
	readonly cause?: FixtureError;
	readonly errors?: readonly FixtureError[];
}

/** Keep shutdown components and their underlying failures across the fixture's JSON RPC boundary. */
export function serializeFixtureError(value: unknown): FixtureError {
	const error = value instanceof Error ? value : new Error(String(value));
	return {
		name: error.name,
		message: error.message,
		stack: error.stack,
		...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
		...(error.cause === undefined ? {} : { cause: serializeFixtureError(error.cause) }),
		...(error instanceof AggregateError ? { errors: error.errors.map(serializeFixtureError) } : {}),
	};
}

export function deserializeFixtureError(value: FixtureError | string): Error {
	if (typeof value === "string") return new Error(value);
	const options = value.cause === undefined ? undefined : { cause: deserializeFixtureError(value.cause) };
	const error = value.errors
		? new AggregateError(value.errors.map(deserializeFixtureError), value.message, options)
		: new Error(value.message, options);
	error.name = value.name;
	if (value.stack !== undefined) error.stack = value.stack;
	if (value.code !== undefined) Object.assign(error, { code: value.code });
	return error;
}
