import type { TestContext } from "vitest";
import { type BuiltinProvider, getBuiltinModels } from "../src/providers/all.ts";

export function publishedModel<P extends BuiltinProvider>(
	provider: P,
	id: string,
	{ skip }: Pick<TestContext, "skip">,
): ReturnType<typeof getBuiltinModels<P>>[number] {
	const model = getBuiltinModels(provider).find((candidate) => candidate.id === id);
	if (model === undefined) return skip(`${provider}/${id} is not in the generated model catalog`);
	return model;
}
