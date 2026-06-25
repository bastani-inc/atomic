import type * as TypeBox from "typebox";
import type {
  TAny,
  TArray,
  TArrayOptions,
  TBoolean,
  TEnum,
  TEnumValue,
  TInteger,
  TIntersect,
  TIntersectOptions,
  TLiteral,
  TLiteralValue,
  TNull,
  TNumber,
  TNumberOptions,
  TObject,
  TObjectOptions,
  TOmit,
  TPartial,
  TPick,
  TProperties,
  TRequired,
  TSchema,
  TSchemaOptions,
  TString,
  TStringOptions,
  TTuple,
  TTupleOptions,
  TTypeScriptEnumLike,
  TTypeScriptEnumToEnumValues,
  TUnion,
  TUnknown,
} from "typebox";
import type { WorkflowSerializableValue } from "../shared/authoring-contract.js";

type TypeBoxDefaultOptions<TOptions> = TOptions & {
  readonly default: WorkflowSerializableValue;
};

type TypeBoxDefaulted<TOptions extends { readonly default: WorkflowSerializableValue }> = {
  readonly default: TOptions["default"];
};

type TypeBoxKeysToLiterals<
  TKeys extends readonly PropertyKey[],
  TResult extends TLiteral[] = [],
> = TKeys extends readonly [infer TLeft extends PropertyKey, ...infer TRight extends PropertyKey[]]
  ? TLeft extends TLiteralValue
    ? TypeBoxKeysToLiterals<TRight, [...TResult, TLiteral<TLeft>]>
    : TypeBoxKeysToLiterals<TRight, TResult>
  : TResult;

type TypeBoxKeysToIndexer<TKeys extends readonly PropertyKey[]> = TUnion<TypeBoxKeysToLiterals<TKeys>>;

type TypeBoxRecord<TKey extends TSchema, TValue extends TSchema> = ReturnType<typeof TypeBox.Type.Record<TKey, TValue>>;

declare module "typebox" {
  export namespace Type {
    export function Any<const TOptions extends TypeBoxDefaultOptions<TSchemaOptions>>(
      options: TOptions,
    ): TAny & TypeBoxDefaulted<TOptions>;

    export function Unknown<const TOptions extends TypeBoxDefaultOptions<TSchemaOptions>>(
      options: TOptions,
    ): TUnknown & TypeBoxDefaulted<TOptions>;

    export function String<const TOptions extends TypeBoxDefaultOptions<TStringOptions>>(
      options: TOptions,
    ): TString & TypeBoxDefaulted<TOptions>;

    export function Number<const TOptions extends TypeBoxDefaultOptions<TNumberOptions>>(
      options: TOptions,
    ): TNumber & TypeBoxDefaulted<TOptions>;

    export function Integer<const TOptions extends TypeBoxDefaultOptions<TNumberOptions>>(
      options: TOptions,
    ): TInteger & TypeBoxDefaulted<TOptions>;

    export function Boolean<const TOptions extends TypeBoxDefaultOptions<TSchemaOptions>>(
      options: TOptions,
    ): TBoolean & TypeBoxDefaulted<TOptions>;

    export function Literal<
      const TValue extends TLiteralValue,
      const TOptions extends TypeBoxDefaultOptions<TSchemaOptions>,
    >(
      value: TValue,
      options: TOptions,
    ): TLiteral<TValue> & TypeBoxDefaulted<TOptions>;

    export function Enum<
      const TValues extends TEnumValue[],
      const TOptions extends TypeBoxDefaultOptions<TSchemaOptions>,
    >(
      values: readonly [...TValues],
      options: TOptions,
    ): TEnum<TValues> & TypeBoxDefaulted<TOptions>;
    export function Enum<
      const TEnumLike extends TTypeScriptEnumLike,
      const TOptions extends TypeBoxDefaultOptions<TSchemaOptions>,
    >(
      value: TEnumLike,
      options: TOptions,
    ): TEnum<TTypeScriptEnumToEnumValues<TEnumLike>> & TypeBoxDefaulted<TOptions>;

    export function Array<
      const TItem extends TSchema,
      const TOptions extends TypeBoxDefaultOptions<TArrayOptions>,
    >(
      items: TItem,
      options: TOptions,
    ): TArray<TItem> & TypeBoxDefaulted<TOptions>;

    export function Object<
      const TSchemaProperties extends TProperties,
      const TOptions extends TypeBoxDefaultOptions<TObjectOptions>,
    >(
      properties: TSchemaProperties,
      options: TOptions,
    ): TObject<TSchemaProperties> & TypeBoxDefaulted<TOptions>;

    export function Partial<
      const TType extends TSchema,
      const TOptions extends TypeBoxDefaultOptions<TSchemaOptions>,
    >(
      type: TType,
      options: TOptions,
    ): TPartial<TType> & TypeBoxDefaulted<TOptions>;

    export function Pick<
      const TType extends TSchema,
      const TIndexer extends PropertyKey[],
      const TOptions extends TypeBoxDefaultOptions<TSchemaOptions>,
    >(
      type: TType,
      indexer: readonly [...TIndexer],
      options: TOptions,
    ): TPick<TType, TypeBoxKeysToIndexer<TIndexer>> & TypeBoxDefaulted<TOptions>;
    export function Pick<
      const TType extends TSchema,
      const TIndexer extends TSchema,
      const TOptions extends TypeBoxDefaultOptions<TSchemaOptions>,
    >(
      type: TType,
      indexer: TIndexer,
      options: TOptions,
    ): TPick<TType, TIndexer> & TypeBoxDefaulted<TOptions>;

    export function Omit<
      const TType extends TSchema,
      const TIndexer extends PropertyKey[],
      const TOptions extends TypeBoxDefaultOptions<TSchemaOptions>,
    >(
      type: TType,
      indexer: readonly [...TIndexer],
      options: TOptions,
    ): TOmit<TType, TypeBoxKeysToIndexer<TIndexer>> & TypeBoxDefaulted<TOptions>;
    export function Omit<
      const TType extends TSchema,
      const TIndexer extends TSchema,
      const TOptions extends TypeBoxDefaultOptions<TSchemaOptions>,
    >(
      type: TType,
      indexer: TIndexer,
      options: TOptions,
    ): TOmit<TType, TIndexer> & TypeBoxDefaulted<TOptions>;

    export function Required<
      const TType extends TSchema,
      const TOptions extends TypeBoxDefaultOptions<TSchemaOptions>,
    >(
      type: TType,
      options: TOptions,
    ): TRequired<TType> & TypeBoxDefaulted<TOptions>;

    export function Union<
      const TTypes extends TSchema[],
      const TOptions extends TypeBoxDefaultOptions<TSchemaOptions>,
    >(
      anyOf: [...TTypes],
      options: TOptions,
    ): TUnion<TTypes> & TypeBoxDefaulted<TOptions>;

    export function Intersect<
      const TTypes extends TSchema[],
      const TOptions extends TypeBoxDefaultOptions<TIntersectOptions>,
    >(
      types: [...TTypes],
      options: TOptions,
    ): TIntersect<TTypes> & TypeBoxDefaulted<TOptions>;

    export function Record<
      const TKey extends TSchema,
      const TValue extends TSchema,
      const TOptions extends TypeBoxDefaultOptions<TObjectOptions>,
    >(
      key: TKey,
      value: TValue,
      options: TOptions,
    ): TypeBoxRecord<TKey, TValue> & TypeBoxDefaulted<TOptions>;

    export function Tuple<
      const TTypes extends TSchema[],
      const TOptions extends TypeBoxDefaultOptions<TTupleOptions>,
    >(
      types: [...TTypes],
      options: TOptions,
    ): TTuple<TTypes> & TypeBoxDefaulted<TOptions>;

    export function Null<const TOptions extends TypeBoxDefaultOptions<TSchemaOptions>>(
      options: TOptions,
    ): TNull & TypeBoxDefaulted<TOptions>;
  }
}

export {};
