import { JournalInvalidTextError, type RunEvent, type RunHeader } from "./types.js";

export function validateText(field: JournalInvalidTextError["field"], value: string): void {
	if (value.includes("\u0000")) throw new JournalInvalidTextError(field, "nul-character");
	if (!value.isWellFormed()) throw new JournalInvalidTextError(field, "ill-formed-unicode");
}

export function serializeJson(value: RunHeader | RunEvent["payload"]): string {
	const text = JSON.stringify(value);
	return text.replace(/\p{Surrogate}/gu, (unit) => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0"));
}
