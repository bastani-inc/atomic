/** The mark jiti's path library puts on an alias map it has already normalized. */
const NORMALIZED_ALIASES = Symbol.for("pathe:normalizedAlias");
const SEPARATOR_OR_END = new Set(["/", "\\", undefined]);

/**
 * The alias map in the form jiti would normalize it to, marked as normalized.
 *
 * jiti normalizes the alias option again for every module it evaluates unless the map carries the mark, and
 * normalizing sorts the whole map and compares every pair of entries. For the host's alias map that was most of the
 * cost of loading an extension's modules. The result has the same entries in the same order as jiti's own
 * normalization: more specific (more `/` segments) aliases first, and a target that starts with another alias
 * resolved through it.
 */
export function normalizeJitiAliases(aliases: Readonly<Record<string, string>>): Record<string, string> {
	const normalized = Object.fromEntries(
		Object.entries(aliases).sort(([a], [b]) => b.split("/").length - a.split("/").length),
	);
	for (const alias in normalized) {
		for (const other in normalized) {
			if (other === alias || alias.startsWith(other)) continue;
			const target = normalized[alias];
			if (target?.startsWith(other) && SEPARATOR_OR_END.has(target[other.length])) {
				normalized[alias] = normalized[other] + target.slice(other.length);
			}
		}
	}
	Object.defineProperty(normalized, NORMALIZED_ALIASES, { value: true, enumerable: false });
	return normalized;
}
