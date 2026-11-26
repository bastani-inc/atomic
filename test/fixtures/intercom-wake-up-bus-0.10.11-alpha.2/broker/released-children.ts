import type { ReleasedChildRefusal } from "../types.js";
import type { JsonWireValue } from "./framing.js";

export const RELEASED_CHILD_FRAME_MAX = 500;
export const RELEASED_CHILD_ALIASES_MAX = 4;
const RELEASED_RESERVATION_PREFIX = "released:";
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DYNAMIC_SLOT_NAME = "*";

export interface ParsedReleasedChild {
	readonly childName: string;
	readonly group?: string;
	readonly aliases: readonly string[];
	readonly wake: boolean;
}

export type ReleasedChildFrameValidation =
	| { readonly ok: true; readonly children: readonly ParsedReleasedChild[] }
	| { readonly ok: false; readonly refusal: ReleasedChildRefusal };

export const normalizeReservationTarget = (target: string): string => target.trim().toLowerCase();

export function releasedReservationKey(childName: string): string {
	return `${RELEASED_RESERVATION_PREFIX}${normalizeReservationTarget(childName)}`;
}

export function isReleasedReservationKey(key: string): boolean {
	return key.startsWith(RELEASED_RESERVATION_PREFIX);
}

/** A restoring subagent's extra targets are ids only: its Atomic session id and its pre-restart Intercom id (#3760). */
export function isRestoringRecipientAlias(alias: string): boolean {
	return SESSION_ID_PATTERN.test(alias.trim());
}

export function isValidChildName(childName: string): boolean {
	const trimmed = childName.trim();
	return trimmed.length > 0 && trimmed !== DYNAMIC_SLOT_NAME;
}

function nameOf(item: JsonWireValue): string | undefined {
	if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
	return typeof item.childName === "string" ? item.childName : undefined;
}

function refuse(code: ReleasedChildRefusal["code"], item?: JsonWireValue): ReleasedChildFrameValidation {
	const childName = item === undefined ? undefined : nameOf(item);
	return { ok: false, refusal: childName === undefined ? { code } : { code, childName } };
}

/**
 * Validate one `reserve_released_children` frame as a whole, before anything is reserved: the same child-name,
 * alias and group rules a supervisor-authorized reservation follows. The first invalid item refuses the frame.
 */
export function validateReleasedChildFrame(children: JsonWireValue | undefined): ReleasedChildFrameValidation {
	if (!Array.isArray(children) || children.length === 0 || children.length > RELEASED_CHILD_FRAME_MAX) {
		return refuse("invalid_frame");
	}
	const parsed: ParsedReleasedChild[] = [];
	for (const item of children) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return refuse("invalid_frame");
		if (typeof item.childName !== "string" || !isValidChildName(item.childName)) return refuse("invalid_child_name", item);
		if (typeof item.wake !== "boolean") return refuse("invalid_frame", item);
		if (item.group !== undefined && typeof item.group !== "string") return refuse("invalid_group", item);
		const aliases = item.aliases ?? [];
		if (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== "string")) return refuse("invalid_alias", item);
		if (aliases.length > RELEASED_CHILD_ALIASES_MAX) return refuse("too_many_aliases", item);
		const aliasIds = aliases as string[];
		if (!aliasIds.every(isRestoringRecipientAlias)) return refuse("invalid_alias", item);
		parsed.push({
			childName: item.childName.trim(),
			...(item.group === undefined ? {} : { group: item.group }),
			aliases: aliasIds,
			wake: item.wake,
		});
	}
	return { ok: true, children: parsed };
}
