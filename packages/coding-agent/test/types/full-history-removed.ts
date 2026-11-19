import type { AgentSessionRuntime, ExtensionContext, SessionManager, SessionOpenOptions } from "../../src/index.ts";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Expect<Value extends true> = Value;

// A session opens at its current context window; "tail" is the only history option left.
export type OpenHistory = Expect<Equal<SessionOpenOptions["history"], "tail" | undefined>>;
export const windowOpen: SessionOpenOptions = { history: "tail" };
// @ts-expect-error { history: "full" } was removed in 0.10.0; read older entries with readHistory()
export const fullOpen: SessionOpenOptions = { history: "full" };

// loadFullHistory() was removed from the manager and from the session manager extensions receive.
export type ManagerHasNoFullLoad = Expect<Equal<Extract<keyof SessionManager, "loadFullHistory">, never>>;
export type ExtensionManagerHasNoFullLoad = Expect<
	Equal<Extract<keyof ExtensionContext["sessionManager"], "loadFullHistory">, never>
>;
export const removedLoad = (manager: SessionManager) =>
	// @ts-expect-error loadFullHistory() was removed in 0.10.0
	manager.loadFullHistory();

export const removedSwitch = (runtime: AgentSessionRuntime) =>
	// @ts-expect-error switchSession no longer accepts { history: "full" }
	runtime.switchSession("session-id", { history: "full" });
export const removedRehydrate = (runtime: AgentSessionRuntime) =>
	// @ts-expect-error rehydrate no longer accepts { history: "full" }
	runtime.rehydrate("session-id", { history: "full" });

// The replacement: page the archive without keeping it in the manager.
export async function firstUserTexts(manager: SessionManager): Promise<string[]> {
	const texts: string[] = [];
	for await (const page of manager.readHistory({ fromSeq: 1 }))
		for (const item of page.items)
			if ("entry" in item && item.entry.type === "message" && item.entry.message.role === "user")
				texts.push(JSON.stringify(item.entry.message.content));
	return texts;
}
