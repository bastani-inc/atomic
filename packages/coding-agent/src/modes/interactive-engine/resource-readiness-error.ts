export class InteractiveEngineResourceReadinessError extends Error {
	readonly generation: number;

	constructor(generation: number, cause: Error) {
		super(cause.message, { cause });
		this.name = "InteractiveEngineResourceReadinessError";
		this.generation = generation;
	}
}

export function isInteractiveEngineResourceReadinessError(
	error: unknown,
): error is InteractiveEngineResourceReadinessError {
	return error instanceof InteractiveEngineResourceReadinessError;
}
