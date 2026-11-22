---
title: "@bastani/atomic-schema"
sidebarTitle: "Schema"
description: "JSON Schema builders and validation without eval, for drafts 2020-12 and 7."
---

JSON Schema builders and validation without `eval`. Each schema compiles once into plain closures, so validation runs without code generation, works under a strict Content Security Policy, and needs no runtime dependencies.

- Supports JSON Schema drafts 2020-12 and 7.
- Builders return plain JSON Schema objects typed with the values they accept, and compiled checks narrow values to that type.
- Errors include JSON Pointer paths. Missing and unknown fields report at the field path.
- Schemas are never mutated, so frozen schemas work.
- Format checks live in an optional subpath import.

Atomic validates tool arguments with `@bastani/atomic-schema`. See [Tool parameter schemas](/extensions#tool-parameter-schemas). Extensions can import `@bastani/atomic-schema` from the host without installing it.

## Installation

```bash
npm install @bastani/atomic-schema
```

## Usage

```typescript
import { compile, int, obj, oneOf, opt, type Static, str } from "@bastani/atomic-schema";

const Read = obj({
	path: str({ description: "Path to the file", minLength: 1 }),
	offset: opt(int({ minimum: 1 })),
	mode: oneOf(["text", "binary"]),
});
type Read = Static<typeof Read>; // { path: string; mode: "text" | "binary"; offset?: number }

const read = compile(Read);
if (read.check(value)) value.path; // value: Read

read.errors({ offset: 0, extra: true });
// [
//   { path: "/path", keyword: "required", message: "missing" },
//   { path: "/mode", keyword: "required", message: "missing" },
//   { path: "/offset", keyword: "minimum", message: "expected >= 1" },
//   { path: "/extra", keyword: "additionalProperties", message: "unknown field" },
// ]
```

`Read` is plain JSON Schema (`{ type: "object", properties: {...}, required: ["path", "mode"], additionalProperties: false }`), ready for a tool definition or `JSON.stringify`. `compile()` accepts any JSON Schema, whether created with the builders or written by hand.

`check(value)` is the fast boolean path. It is a standalone function you can pass around, and it avoids allocations for most schemas.

`errors(value)` explains failures and returns `[]` for valid values. The error explainer is built on the first failure and reused, so schemas whose inputs always pass never pay for it. `validate(value)` runs both without modifying the input and returns `{ ok: true, value }` or `{ ok: false, errors }`.

### Builders

| Builder | Schema | Type |
| --- | --- | --- |
| `str({ minLength, maxLength, pattern, format })` | `{ type: "string", ... }` | `string` |
| `num({ minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf })`, `int(...)` | `{ type: "number" }`, `{ type: "integer" }` | `number` |
| `bool()`, `nul()`, `unknown()` | `{ type: "boolean" }`, `{ type: "null" }`, `{}` | `boolean`, `null`, `unknown` |
| `lit(value)` | `{ const: value }` | the literal |
| `oneOf(["a", "b"])` | `{ enum: [...] }` | `"a" \| "b"` |
| `obj({ a: str(), b: opt(num()) }, { open })` | closed object; `open: true` allows other properties | `{ a: string; b?: number }` |
| `arr(items, { minItems, maxItems, uniqueItems })` | `{ type: "array", items }` | `T[]` |
| `tuple([str(), num()])` | `prefixItems`, no additional items | `[string, number]` |
| `map(value)` | `{ type: "object", additionalProperties: value }` | `Record<string, T>` |
| `union([...])` | `{ anyOf: [...] }` | the union |
| `nullable(schema)` | `{ anyOf: [schema, { type: "null" }] }` | `T \| null` |
| `bytes({ minLength, maxLength })` | `{ type: "bytes", ... }` | `Uint8Array` |
| `bigint({ minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf })` | `{ type: "bigint", ... }`, bigint bounds | `bigint` |
| `unsafe<T>(schema)` | `schema` as given (`{}` by default) | `T`, unchecked |
| `recursive<T>(id, (self) => schema)` | `schema` with `$id: id`; `self` is `{ $ref: id }` | `T` |

Every builder also accepts `title`, `description`, `examples`, `deprecated`, and `default`. A `default` is an annotation only, and validation never inserts it.

A union of objects tagged by a `lit()` property checks and reports errors by the tag. Only the branch matching the tag runs.

```typescript
const Block = union([obj({ kind: lit("text"), text: str() }), obj({ kind: lit("image"), width: int({ minimum: 0 }) })]);
compile(Block).errors({ kind: "video" });
// [{ path: "/kind", keyword: "anyOf", message: 'expected one of ["text","image"]' }]
```

A recursive schema needs an explicit type argument because TypeScript cannot infer recursive types from builders. Its `id` must be unique among recursive schemas inside the same root schema:

```typescript
type Tree = { name: string; children: Tree[] };
const Tree = recursive<Tree>("Tree", (self) => obj({ name: str(), children: arr(self) }));
```

`Static` also infers types for TypeBox 1.x schemas by reading TypeBox's type shapes without importing TypeBox. Supported TypeBox kinds are `String`, `Number`, `Integer`, `Boolean`, `Null`, `Literal`, `Array`, `Object` (with `Type.Optional` and `Type.Readonly` properties), `Union`, `Record`, `Enum`, `Tuple`, `BigInt`, `Undefined`, `Unsafe`, `Unknown`, and `Any`. For example, `Static<typeof Type.Object({ path: Type.String() })>` resolves to `{ path: string }`.

Other TypeBox kinds such as `Intersect`, `Cyclic`, and `Ref` resolve to `unknown`, as do plain JSON Schema objects without builder brands.

### Options

```typescript
import { formats } from "@bastani/atomic-schema/formats";

const validator = compile(schema, {
	draft: "7", // "2020-12" (default) or "7"
	formats, // check `format`; without it `format` is an annotation, as 2020-12 specifies
	schemas: { "https://example.com/point.json": point }, // documents for $refs to other documents, by URI
	unresolvedRefs: "reject", // a $ref that names nothing rejects values at its place; default "throw"
	coerce: true, // adds coerce() and parse(), see Coercion
});
```

`formats` includes every format defined in JSON Schema 2020-12 (`date-time`, `email`, `uri`, `uuid`, `ipv6`, and the rest), plus `url` and `json-pointer-uri-fragment`. Pass your own record to check a subset of formats or add custom checks.

By default, an unresolved `$ref` (a missing definition or a document not in `schemas`) throws during `compile()`. With `unresolvedRefs: "reject"`, that reference compiles as `false` instead. Only values at that position fail, with the error `unresolved reference <ref>`, while the rest of the schema continues to validate. Use this option for external schemas such as MCP tool schemas whose references may dangle.

### TypeBox schemas

TypeBox 1.x schemas are JSON Schema objects, so they compile directly:

```typescript
import Type from "typebox";

const user = compile(Type.Object({ name: Type.String(), tags: Type.Array(Type.String()) }));
```

TypeBox's `BigInt` and `Undefined` types are supported (see Values). JavaScript-only types such as `Function` and `Symbol`, along with refinements and codecs, are not JSON Schema and are not supported.

### Coercion

`compile(schema, { coerce: true })` adds `coerce()` and `parse()` for loosely typed inputs such as model tool call arguments. Without `coerce: true`, the validator exposes neither method and builds no coercion code. Even with `coerce: true`, coercion rules are built lazily on the first call to `coerce()` or `parse()`.

```typescript
const read = compile(Read, { coerce: true });

read.coerce({ path: "a.txt", offset: "10", mode: "text" }); // { path: "a.txt", offset: 10, mode: "text" }

const result = read.parse({ path: "a.txt", offset: "ten", mode: "text" });
if (result.ok) result.value.offset; // number
else result.errors; // [{ path: "/offset", keyword: "type", message: "expected integer, got string" }]
```

`coerce(value)` returns the coerced value. It copies only changed paths, returns `value` unchanged when no rule applies, and never mutates `value`. `parse(value)` coerces and then validates, returning `{ ok: true, value }` for a valid coerced value or `{ ok: false, errors }` when validation fails.

Three passes run in order:

1. **Optional nulls.** A `null` in an optional property whose schema rejects `null` is dropped as if omitted.
2. **TypeBox-style conversions.** Runs on the first applicable JSON Schema keyword. `$ref` follows the reference. `const` and `enum` pick the member the value converts to. `anyOf` and `oneOf` keep a value one branch already accepts, or take the first branch conversion that passes the whole schema. `allOf` converts with each member in order. Otherwise, conversion follows `type`:
   * `string`: numbers and booleans become text, and `null` becomes `"null"`.
   * `number`: numeric strings (`""` becomes `0`), `"true"` and `"false"`, booleans become `1` or `0`, and `null` becomes `0`.
   * `integer`: same as `number`, then truncated (`"3.5"` and `3.5` become `3`).
   * `boolean`: `"true"` and `"false"` in any case, `"1"` and `"0"`, `1` and `0`, and `null` becomes `false`.
   * `null`: `"null"`, `"undefined"`, `""`, `"0"`, `0`, and `false`.
   * `bigint`: integer strings (`"12"`, `"12n"`, with `"12.9"` truncated), numbers truncated, `"true"`, `"false"`, and booleans become `1n` or `0n`, and `null` becomes `0n`.
   * `undefined`: `"undefined"`, `"null"`, `""`, `"0"`, `0`, `0n`, `false`, and `null`.
   * `array`: a single value becomes a one-item array, then each item converts. A tuple (`prefixItems` or a draft-7 `items` array) converts its items without wrapping.
   * `object`: each property converts according to `properties`, `patternProperties`, or `additionalProperties`.
3. **Scalar coercion by type.** Matches Ajv's `coerceTypes` for values left by pass 2, such as type arrays like `["integer", "null"]`. Numbers convert from numeric strings and booleans, booleans from `"true"`, `"false"`, `1`, and `0`, strings from numbers and booleans, `null` from `""`, `0`, and `false`, and `null` converts to `""`, `0`, or `false`. A value that already matches one type in a type array stays unchanged.

Where passes 2 and 3 disagree, pass 2 wins. For example, `null` for a required string becomes `"null"`, not `""`.

Union branches convert in order and stop at the first accepted branch. If a union node also declares properties, those properties convert into each candidate before checking it. In recursive schemas reached through `$ref`, a value that cannot convert stays unchanged so `check()` reports it, and `$ref` results are reused within one call so recursive unions do not re-convert the same child for every branch.

Pass 1 drops optional nulls inside values of `properties`, `patternProperties`, and `additionalProperties`, while leaving pattern and additional keys themselves intact. Items past a draft-7 `items` array (`additionalItems`) are not coerced by any pass.

### Values

- An optional property whose value is `undefined` counts as absent, matching TypeBox. A required property set to `undefined` counts as present. It is valid when its schema accepts `undefined` (`Type.Undefined()`, `Type.Unknown()`, or `Type.Any()`), and reported as missing otherwise.
- `{ type: "bytes", minLength, maxLength }` matches a `Uint8Array` within those length bounds for binary values that do not pass through JSON.
- `{ type: "bigint" }` matches a `bigint`. Number bounds (`minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`) apply to both numbers and bigints with bounds of either kind.
- `{ type: "undefined" }` matches `undefined`.
- `equal(a, b)` checks JSON value equality using the same rules as `const`, `enum`, and `uniqueItems`.

## Supported keywords

- Every validation keyword of drafts 2020-12 and 7, including draft 7's `dependencies` and `items` arrays with `additionalItems`.
- `$id`, `$anchor`, `$ref` (local, anchor, relative, and remote), `$dynamicRef`, and `$dynamicAnchor`.
- `unevaluatedProperties` and `unevaluatedItems`.
- `pattern` and `patternProperties` run as ECMAScript regular expressions with the `u` flag.
- Unsupported keywords: `$vocabulary` meta-schema switches, optional `contentMediaType` and `contentEncoding` assertions, and draft 2019-09's `$recursiveRef`.
