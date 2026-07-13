import {
	allocateCollisionSafeIds,
	cursorGroupPresentation,
	type CursorGroupPresentation,
} from "./model-display.js";
import type {
	CursorEffort,
	CursorVariant,
	CursorVariantGroup,
} from "./model-mapper.js";

interface CursorVariantGroupDraft {
	readonly baseId: string;
	readonly presentation: CursorGroupPresentation;
	readonly variants: readonly CursorVariant[];
}

const EFFORT_ORDER: readonly CursorEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "extra-high", "max"];

export function groupCursorModels(models: readonly CursorVariant[]): CursorVariantGroup[] {
	const groups = new Map<string, CursorVariant[]>();
	for (const variant of models) {
		const key = cursorVariantGroupKey(variant);
		const existing = groups.get(key) ?? [];
		existing.push(variant);
		groups.set(key, existing);
	}
	const drafts: CursorVariantGroupDraft[] = [...groups.entries()].map(([signature, variants]) => {
		const baseId = variants[0]?.baseId ?? "cursor";
		const legacyPrimaryId = chooseLegacyPrimaryId(variants, baseId);
		return {
			baseId,
			presentation: variants.some((variant) => variant.parameterized)
				? parameterizedGroupPresentation(variants)
				: {
					desiredId: legacyPrimaryId,
					name: chooseDisplayName(variants, baseId, legacyPrimaryId),
					signature,
				},
			variants,
		};
	});
	const ids = allocateCollisionSafeIds(drafts.map((draft) => draft.presentation));
	return drafts
		.map((draft, index) => ({
			baseId: draft.baseId,
			primaryId: ids[index] ?? draft.presentation.desiredId,
			displayName: draft.presentation.name,
			variants: draft.variants,
		}))
		.sort((left, right) => left.primaryId.localeCompare(right.primaryId));
}

export function selectDefaultVariant(variants: readonly CursorVariant[]): CursorVariant {
	const explicit = variants.find((variant) => variant.isDefaultVariant);
	if (explicit) return explicit;
	return [...variants].sort((left, right) => {
		const effortOrder = effortSortIndex(left.effort) - effortSortIndex(right.effort);
		return effortOrder || left.id.localeCompare(right.id);
	})[0] ?? variants[0]!;
}

export function chooseLegacyPrimaryId(variants: readonly CursorVariant[], baseId: string): string {
	if (variants.some((variant) => variant.effort)) {
		const explicitDefault = variants.find((variant) => variant.isDefaultVariant);
		if (explicitDefault) {
			return `${baseId}${explicitDefault.thinking ? "-thinking" : ""}${explicitDefault.fast ? "-fast" : ""}`;
		}
		return variants[0]?.id ?? baseId;
	}
	return variants.find((variant) => variant.id === baseId)?.id ?? variants[0]?.id ?? baseId;
}

export function cursorModelAliases(group: CursorVariantGroup): readonly string[] {
	const legacyPrimaryId = chooseLegacyPrimaryId(group.variants, group.baseId);
	return [...new Set([legacyPrimaryId, ...group.variants.map((variant) => variant.id)])]
		.filter((id) => id !== group.primaryId)
		.sort();
}

export function titleCaseModelId(id: string): string {
	return id
		.split(/[-_/]+/u)
		.filter((part) => part.length > 0)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function parameterizedGroupPresentation(variants: readonly CursorVariant[]): CursorGroupPresentation {
	const representative = selectDefaultVariant(variants);
	const parameters = representative.routing.parameters ?? [];
	const effortParameter = representative.effort
		? parameters.find((parameter) => parameter.id === "reasoning" || parameter.id === "effort")
		: undefined;
	return cursorGroupPresentation({
		sourceModelId: representative.sourceModelId,
		displayName: representative.displayName,
		isMaxMode: representative.routing.maxMode === true,
		parameters,
		effortParameter,
		definitions: representative.parameterDefinitions,
	});
}

function cursorVariantGroupKey(variant: CursorVariant): string {
	if (!variant.parameterized) return `${variant.baseId}|fast=${variant.fast ? "1" : "0"}|thinking=${variant.thinking ? "1" : "0"}`;
	const parameters = (variant.routing.parameters ?? []).filter((parameter) => !(
		variant.effort && (parameter.id === "reasoning" || parameter.id === "effort")
	));
	return JSON.stringify([variant.sourceModelId, variant.routing.maxMode === true, parameters]);
}

function chooseDisplayName(variants: readonly CursorVariant[], baseId: string, primaryId: string): string {
	return variants.find((variant) => variant.id === primaryId)?.displayName
		?? variants.find((variant) => variant.effort === "medium")?.displayName
		?? variants.find((variant) => !variant.effort)?.displayName
		?? variants[0]?.displayName
		?? titleCaseModelId(baseId);
}

function effortSortIndex(effort: CursorEffort | undefined): number {
	if (!effort) return -1;
	const index = EFFORT_ORDER.indexOf(effort === "default" ? "none" : effort);
	return index < 0 ? EFFORT_ORDER.length : index;
}
