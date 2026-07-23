import { StringEnum as PiStringEnum } from "@earendil-works/pi-ai/compat";
import type { TUnsafe } from "typebox";

export interface StringEnumOptions<TValue extends string> {
	description?: string;
	default?: TValue;
}

/**
 * Build Pi's Google-compatible string enum with the direct TypeBox schema identity.
 * Pi 0.80.7 pins an older TypeBox instance, so this narrow boundary keeps extension
 * schemas portable when they compose the result with Atomic's direct TypeBox version.
 */
export function StringEnum<const TValues extends readonly string[]>(
	values: TValues,
	options?: StringEnumOptions<TValues[number]>,
): TUnsafe<TValues[number]> {
	return PiStringEnum(values, options) as never;
}
