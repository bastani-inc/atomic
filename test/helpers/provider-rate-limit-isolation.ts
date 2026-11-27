import { beforeEach } from "vitest";

beforeEach(() => {
	const state = Reflect.get(globalThis, Symbol.for("atomic-coding-agent/provider-rate-limits@1")) as
		| { providers: Map<string, object>; accounts?: Map<string, object>; providerAccounts?: Map<string, Set<string>> }
		| undefined;
	state?.providers.clear();
	state?.accounts?.clear();
	state?.providerAccounts?.clear();
});
