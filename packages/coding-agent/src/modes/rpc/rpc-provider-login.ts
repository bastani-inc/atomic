import type { AgentSession } from "../../core/agent-session.ts";
import type { HostInputFormRequest } from "../../core/extensions/ui-types.ts";
import { createRpcSuccessResponse } from "./rpc-responses.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";

export interface ProviderLoginInput {
	open(request: HostInputFormRequest, signal?: AbortSignal): Promise<Record<string, string> | undefined>;
}

type LoginProviderCommand = Extract<RpcCommand, { type: "login_provider" }>;

export async function handleProviderLogin(
	command: LoginProviderCommand,
	session: AgentSession,
	inputForm: ProviderLoginInput | undefined,
	controllers: Map<string, AbortController>,
): Promise<RpcResponse> {
	const customAuth = session.modelRegistry.getCustomApiKeyAuth(command.provider);
	if (!customAuth) throw new Error(`Provider does not support custom API-key login: ${command.provider}`);
	if (!inputForm) throw new Error("Provider login requires an interactive input host");
	if (controllers.has(command.provider)) throw new Error(`Login already in progress: ${command.provider}`);
	const controller = new AbortController();
	controllers.set(command.provider, controller);
	try {
		const credential = await customAuth.login({
			signal: controller.signal,
			prompt: async (prompt) => {
				const values = await inputForm.open({
					title: prompt.message,
					heading: "PROVIDER LOGIN",
					submitLabel: "[ Submit ]",
					fields: [{ name: "value", type: "string", required: false, initialValue: "", placeholder: prompt.placeholder }],
				}, controller.signal);
				if (!values || controller.signal.aborted) throw new Error("Login cancelled");
				return values.value ?? "";
			},
		});
		if (controller.signal.aborted) return createRpcSuccessResponse(command.id, "login_provider", { provider: command.provider, cancelled: true });
		session.modelRegistry.authStorage.set(command.provider, credential);
		await session.modelRegistry.refresh();
		return createRpcSuccessResponse(command.id, "login_provider", {
			provider: command.provider,
			cancelled: false,
			credential,
			models: session.modelRegistry.getAvailable(),
			scopedModels: session.scopedModels,
			customAuthProviders: session.modelRegistry.getCustomApiKeyAuthProviders(),
		});
	} catch (error) {
		if (controller.signal.aborted || (error instanceof Error && error.message === "Login cancelled")) {
			return createRpcSuccessResponse(command.id, "login_provider", { provider: command.provider, cancelled: true });
		}
		throw error;
	} finally {
		if (controllers.get(command.provider) === controller) controllers.delete(command.provider);
	}
}
