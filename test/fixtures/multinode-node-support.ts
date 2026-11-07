/**
 * What the processes that stand for nodes in the multi-node resume scenarios (#4329) share: JSON lines on stdout, the
 * typed failure they end with, and a model runtime with a scripted faux model.
 */
import { join } from "node:path";
import { registerFauxProvider } from "@bastani/pi-ai/compat";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";

export function emit(value: object): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

interface TypedFailure {
	readonly name?: string;
	readonly code?: string;
	readonly message?: string;
	readonly retryable?: boolean;
	readonly cause?: { readonly name?: string; readonly code?: string };
}

/** Prints the failure a node ends with: its name, code and retryability, and its cause's, never a stack. */
export function emitFailure(error: unknown): void {
	const typed = error as TypedFailure;
	emit({
		error: {
			name: typed.name,
			code: typed.code,
			retryable: typed.retryable,
			message: typed.message,
			cause: typed.cause === undefined ? undefined : { name: typed.cause.name, code: typed.cause.code },
		},
	});
}

/** A scripted faux model registered on a model runtime of its own, which sessions of the node run on. */
export async function fauxNodeRuntime(agentDir: string) {
	const faux = registerFauxProvider();
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: join(agentDir, "models.json") });
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: faux.models.map((registered) => ({
			id: registered.id,
			name: registered.name,
			api: registered.api,
			reasoning: registered.reasoning,
			input: registered.input,
			cost: registered.cost,
			contextWindow: registered.contextWindow,
			maxTokens: registered.maxTokens,
			baseUrl: registered.baseUrl,
		})),
	});
	return { faux, model, modelRuntime };
}
