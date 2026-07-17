import type { VerbatimCompactionParameters, VerbatimCompactionPreparation } from "./compaction-types.js";

/** Internal origin of the normalized relevance focus; never inferred from query text. */
export type CompactionQueryProvenance = "auto-derived" | "explicit";

const provenanceByPreparation = new WeakMap<VerbatimCompactionPreparation, CompactionQueryProvenance>();

/** Classify only by caller/settings presence so arbitrary equal user text is never deduplicated. */
export function compactionQueryProvenance(
	input: Pick<Partial<VerbatimCompactionParameters>, "query">,
): CompactionQueryProvenance {
	return input.query?.trim() ? "explicit" : "auto-derived";
}

/** Return provenance, conservatively treating external/manual preparations as explicit. */
export function getCompactionQueryProvenance(preparation: VerbatimCompactionPreparation): CompactionQueryProvenance {
	return provenanceByPreparation.get(preparation) ?? "explicit";
}

/** Attach provenance without extending public preparation, parameter, or result shapes. */
export function setCompactionQueryProvenance(
	preparation: VerbatimCompactionPreparation,
	provenance: CompactionQueryProvenance,
): void {
	provenanceByPreparation.set(preparation, provenance);
}
