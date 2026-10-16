import {
	JournalCounterRangeError,
	JournalError,
	JournalInvalidTextError,
	type RunEvent,
	type RunHeader,
	StorageUnavailableError,
} from "./types.js";

export function validateText(field: JournalInvalidTextError["field"], value: string): void {
	if (value.includes("\u0000")) throw new JournalInvalidTextError(field, "nul-character");
	if (/\p{Surrogate}/u.test(value)) throw new JournalInvalidTextError(field, "ill-formed-unicode");
}

export function serializeJson(value: RunHeader | RunEvent["payload"]): string {
	const text = JSON.stringify(value);
	return text.replace(/\p{Surrogate}/gu, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function journalCounter(
	runId: string,
	field: "seq" | "epoch",
	value: number | bigint,
	reason: "overflow" | "unsafe-integer" = "unsafe-integer",
): number {
	const counter = Number(value);
	if (counter < 0) throw new JournalCounterRangeError(runId, field, counter, "negative");
	if (!Number.isSafeInteger(counter)) throw new JournalCounterRangeError(runId, field, counter, reason);
	return counter;
}

export function storageBoundary<T>(location: string, operation: () => T): T {
	try {
		return operation();
	} catch (cause) {
		if (cause instanceof JournalError) throw cause;
		throw new StorageUnavailableError(
			{ adapter: "memory", location },
			cause instanceof Error ? cause : new Error(String(cause)),
		);
	}
}
