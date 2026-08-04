import { type TSchema, Type } from "typebox";

/**
 * Tool parameter schemas must be object-rooted to survive provider conversion.
 *
 * Providers advertise a tool's `input_schema` from the root `properties`/`required`
 * keywords alone (pi-ai `convertTools`). A union-rooted schema serializes to
 * `{anyOf}` and carries neither, so the tool ships as
 * `{"type":"object","properties":{},"required":[]}`: every argument becomes
 * untyped, clients that derive argument types from the advertised schema send
 * containers as strings, and validation then rejects them against the union that
 * is still enforced. A union root also gets no argument coercion, because
 * `Value.Convert` cannot rewrite a union in place.
 *
 * Rewriting the root to an object whose properties are the merged branch
 * properties fixes both: the advertised schema regains real properties, and
 * coercion applies in place. Validation strictness is preserved by keeping the
 * original branches under `anyOf` on the rewritten root, so a value must satisfy
 * both the merged object and one full branch. The accepted value set is
 * therefore unchanged.
 *
 * A schema is advertisable exactly when it carries root `properties`, so that is
 * the test used throughout — it mirrors what the provider actually reads.
 */

/**
 * Cached rewrites keyed by the authored schema, so repeated registry refreshes reuse one
 * normalized schema — and therefore one compiled validator in the provider's
 * identity-keyed validator cache.
 */
const normalizedSchemas = new WeakMap<TSchema, TSchema>();
/** Schemas already reported as unrepresentable, so a refresh loop cannot spam the warning. */
const warnedSchemas = new WeakSet<TSchema>();

type SchemaLike = {
	readonly properties?: Record<string, TSchema>;
	readonly required?: readonly string[];
	readonly additionalProperties?: unknown;
	readonly anyOf?: readonly TSchema[];
	readonly description?: string;
	readonly title?: string;
};

/**
 * Merge object-rooted union branches into one object root.
 *
 * Returns `undefined` when any branch is not itself object-rooted, because the
 * merged root could not then represent that branch's shape.
 */
function mergeObjectBranches(branches: readonly TSchema[]): TSchema | undefined {
	if (branches.length === 0) return undefined;
	const objectBranches: SchemaLike[] = [];
	for (const branch of branches) {
		const candidate = branch as SchemaLike;
		if (candidate.properties === undefined) return undefined;
		objectBranches.push(candidate);
	}

	// A property is required on the merged root only when every branch requires it;
	// anything else stays optional and is constrained by the retained `anyOf`.
	const requiredEverywhere = (objectBranches[0]?.required ?? []).filter((key) =>
		objectBranches.every((branch) => (branch.required ?? []).includes(key)),
	);

	// Collect each property's distinct shapes across branches. A discriminator such
	// as `kind` differs per branch, so first-wins would silently pin the root to one
	// branch's literal; the variants are unioned instead.
	const variantsByKey = new Map<string, TSchema[]>();
	for (const branch of objectBranches) {
		for (const [key, propertySchema] of Object.entries(branch.properties ?? {})) {
			const variants = variantsByKey.get(key);
			if (variants === undefined) {
				variantsByKey.set(key, [propertySchema]);
				continue;
			}
			const serialized = JSON.stringify(propertySchema);
			if (!variants.some((variant) => variant === propertySchema || JSON.stringify(variant) === serialized)) {
				variants.push(propertySchema);
			}
		}
	}

	const properties: Record<string, TSchema> = {};
	for (const [key, variants] of variantsByKey) {
		const first = variants[0];
		if (first === undefined) continue;
		const merged = variants.length === 1 ? first : Type.Union(variants);
		properties[key] = requiredEverywhere.includes(key) ? merged : Type.Optional(merged);
	}

	const closed = objectBranches.every((branch) => branch.additionalProperties === false);
	return Type.Object(properties, {
		...(closed ? { additionalProperties: false } : {}),
		// Retaining the branches keeps validation exactly as strict as the union root.
		anyOf: branches,
	});
}

/**
 * Rewrite a union-rooted tool parameter schema to an equivalent object root.
 *
 * Object-rooted schemas are returned unchanged. A root that is neither object-rooted
 * nor a union of object-rooted branches cannot be advertised at all; it is returned
 * unchanged and reported once, so the defect surfaces at registration instead of
 * silently producing an argument-less tool at turn time.
 */
export function normalizeToolParameterSchema<TParams extends TSchema>(schema: TParams, toolName: string): TParams {
	const candidate = schema as SchemaLike;
	if (candidate.properties !== undefined) return schema;

	const cached = normalizedSchemas.get(schema);
	if (cached !== undefined) return cached as TParams;

	const merged = candidate.anyOf === undefined ? undefined : mergeObjectBranches(candidate.anyOf);
	if (merged === undefined) {
		if (!warnedSchemas.has(schema)) {
			warnedSchemas.add(schema);
			console.warn(
				`Warning: tool "${toolName}" has a parameter schema that is not object-rooted, so it will be ` +
					"advertised with no parameters. Use an object root (optionally a union of object roots) for " +
					"tool parameters.",
			);
		}
		return schema;
	}

	// Carry the root's documentation keywords onto the rewritten root.
	if (candidate.description !== undefined) Object.assign(merged, { description: candidate.description });
	if (candidate.title !== undefined) Object.assign(merged, { title: candidate.title });

	normalizedSchemas.set(schema, merged);
	// Sound at runtime: the rewritten root accepts exactly the values the union accepted,
	// so `Static<TParams>` still describes every value reaching the tool.
	return merged as TParams;
}
