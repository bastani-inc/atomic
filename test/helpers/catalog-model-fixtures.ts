import type { Api, ImageApi, ImageModel, Model } from "@bastani/atomic-ai";
import fixture from "../fixtures/model-catalog.json" with { type: "json" };

type Fixture = typeof fixture & { "azure-openai-responses": (typeof fixture)["azure"] };
type Provider = keyof Fixture;
type Groups = Record<string, Record<string, object>>;
type ModelKind = "chat" | "image";

type Keys<G extends Groups> = { [A in keyof G]: keyof G[A] }[keyof G];
type Ids<G extends Groups, T extends ModelKind> =
	Keys<G> extends infer K ? (K extends `${T}:${infer I}` ? I : never) : never;

type Channels<T extends ModelKind> = {
	[P in Provider]: {
		[I in Ids<Fixture[P], T>]: {
			[A in keyof Fixture[P]]: `${T}:${I}` extends keyof Fixture[P][A] ? A : never;
		}[keyof Fixture[P]];
	};
};

type Chat = Channels<"chat">;
type Image = Channels<"image">;

const providers: Record<string, Groups> = fixture;

function readFixture(provider: Provider, kind: ModelKind, id: string): object {
	const canonical = provider === "azure-openai-responses" ? "azure" : provider;
	const key = `${kind}:${id}`;
	for (const models of Object.values(providers[canonical] ?? {})) {
		if (Object.hasOwn(models, key)) return models[key]!;
	}
	throw new Error(`Missing test model fixture ${provider}/${id} in test/fixtures/model-catalog.json`);
}

export function getFixtureModel<P extends Provider, I extends keyof Chat[P]>(
	provider: P,
	id: I,
): Model<Chat[P][I] & Api> {
	return readFixture(provider, "chat", id as string) as Model<Chat[P][I] & Api>;
}

export function getFixtureImageModel<P extends Provider, I extends keyof Image[P]>(
	provider: P,
	id: I,
): ImageModel<Image[P][I] & ImageApi> {
	return readFixture(provider, "image", id as string) as ImageModel<Image[P][I] & ImageApi>;
}
