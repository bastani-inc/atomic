import { beforeEach } from "vitest";

beforeEach(() => {
	const state = Reflect.get(globalThis, Symbol.for("atomic-coding-agent/provider-rate-limits@1")) as
		| { providers: Map<string, object> }
		| undefined;
	state?.providers.clear();
});
