---
title: "@bastani/atomic-schema"
sidebarTitle: "Schema"
description: "JSON Schema builders and validation without eval, for drafts 2020-12 and 7."
---

JSON Schema builders and validation without `eval`. A schema compiles once into plain closures, so it checks values
at close to the speed of validators that generate code, also under a strict Content Security Policy, and needs no
dependencies.

- Drafts 2020-12 and 7. Passes 2,222 of the 2,223 core tests of the official
  [JSON-Schema-Test-Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite).
- Builders return plain JSON Schema typed with the values it accepts; a compiled check narrows to that type.
- Errors as JSON Pointer paths. A missing or unknown field is reported at the field.
- Never modifies a schema; frozen schemas work.
- 8.5 KB minified and gzipped. Format checks are an optional import.

Atomic validates tool arguments with it; see [Tool parameter schemas](/extensions#tool-parameter-schemas). Extensions can import it from the host without installing it.

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

`Read` is plain JSON Schema (`{ type: "object", properties: {...}, required: ["path", "mode"], additionalProperties:
false }`), ready for a tool definition or `JSON.stringify`. `compile` takes any JSON Schema, built with the builders
or not.

`check(value)` is the fast path: a boolean, no allocations for most schemas, and a plain function you can pass
around. `errors(value)` explains a failure and returns `[]` for a valid value. It is built on the first failure and
kept, so a schema whose values always pass never pays for it. `validate(value)` combines the two without changing
the value: `{ ok: true, value }` or `{ ok: false, errors }`.

### Builders

| builder | schema | type |
|---|---|---|
| `str({ minLength, maxLength, pattern, format })` | `{ type: "string", ... }` | `string` |
| `num({ minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf })`, `int(...)` | `{ type: "number" }`, `{ type: "integer" }` | `number` |
| `bool()`, `nul()`, `unknown()` | `{ type: "boolean" }`, `{ type: "null" }`, `{}` | `boolean`, `null`, `unknown` |
| `lit(value)` | `{ const: value }` | the literal |
| `oneOf(["a", "b"])` | `{ enum: [...] }` | `"a" \| "b"` |
| `obj({ a: str(), b: opt(num()) }, { open })` | closed object; `open: true` allows other properties | `{ a: string; b?: number }` |
| `arr(items, { minItems, maxItems, uniqueItems })` | `{ type: "array", items }` | `T[]` |
| `tuple([str(), num()])` | `prefixItems`, no more items | `[string, number]` |
| `map(value)` | `{ type: "object", additionalProperties: value }` | `Record<string, T>` |
| `union([...])` | `{ anyOf: [...] }` | the union |
| `nullable(schema)` | `{ anyOf: [schema, { type: "null" }] }` | `T \| null` |
| `bytes({ minLength, maxLength })` | `{ type: "bytes", ... }` | `Uint8Array` |
| `bigint({ minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf })` | `{ type: "bigint", ... }`, bigint bounds | `bigint` |
| `unsafe<T>(schema)` | `schema` as given (`{}` by default) | `T`, unchecked |
| `recursive<T>(id, (self) => schema)` | `schema` with `$id: id`; `self` is `{ $ref: id }` | `T` |

Every builder also takes `title`, `description`, `examples`, `deprecated` and `default`. A `default` is an annotation;
validation never inserts it.

A union of objects tagged by a `lit()` property checks and reports by the tag: only the branch the tag selects runs.

```typescript
const Block = union([obj({ kind: lit("text"), text: str() }), obj({ kind: lit("image"), width: int({ minimum: 0 }) })]);
compile(Block).errors({ kind: "video" });
// [{ path: "/kind", keyword: "anyOf", message: 'expected one of ["text","image"]' }]
```

A recursive schema needs its type spelled out, since TypeScript cannot infer one from the builders. Its `id` must be
unique among the recursive schemas within one schema:

```typescript
type Tree = { name: string; children: Tree[] };
const Tree = recursive<Tree>("Tree", (self) => obj({ name: str(), children: arr(self) }));
```

`Static` also types schemas built with TypeBox 1.x, read from TypeBox's type shapes (`@bastani/atomic-schema` does not import
TypeBox): `String`, `Number`, `Integer`, `Boolean`, `Null`, `Literal`, `Array`, `Object` (with `Type.Optional` and
`Type.Readonly` properties), `Union`, `Record`, `Enum`, `Tuple`, `BigInt`, `Undefined`, `Unsafe`, `Unknown` and `Any`
give TypeBox's own static type, so `Static<typeof Type.Object({ path: Type.String() })>` is `{ path: string }`. Other
TypeBox kinds (`Intersect`, `Cyclic`, `Ref`, ...) give `unknown` where they stand. Other JSON Schema objects give
`unknown`.

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

`formats` has every format 2020-12 defines (`date-time`, `email`, `uri`, `uuid`, `ipv6`, ...), plus `url` and
`json-pointer-uri-fragment`, which TypeBox and ajv-formats also check. Pass your own map to check fewer formats, or
custom ones.

A `$ref` that names nothing (a missing definition, a document not in `schemas`) throws when the schema compiles. With
`unresolvedRefs: "reject"` it compiles as `false` instead: only values at that place fail, with the error
`unresolved reference <ref>`, and the rest of the schema works. Use it for schemas from other systems, such as MCP
servers, whose references may dangle.

### TypeBox schemas

TypeBox 1.x schemas are JSON Schema, so they compile as they are:

```typescript
import Type from "typebox";

const user = compile(Type.Object({ name: Type.String(), tags: Type.Array(Type.String()) }));
```

TypeBox's `BigInt` and `Undefined` are supported (see Values). Its other JavaScript-only types (`Function`, `Symbol`,
...), refinements and codecs are not JSON Schema and are not supported.

`@bastani/atomic-schema/typebox` and its subpaths (`/compile`, `/value`, `/format` and TypeBox's others) export the copy
of TypeBox that Atomic uses; `@bastani/atomic/typebox` re-exports it.

### Coercion

`compile(schema, { coerce: true })` adds `coerce()` and `parse()`, for loosely typed input such as a model's tool call
arguments. Without the option the validator has neither, and its `check` pays nothing for them: the coercion rules are
built on the first `coerce()` or `parse()`.

```typescript
const read = compile(Read, { coerce: true });

read.coerce({ path: "a.txt", offset: "10", mode: "text" }); // { path: "a.txt", offset: 10, mode: "text" }

const result = read.parse({ path: "a.txt", offset: "ten", mode: "text" });
if (result.ok) result.value.offset; // number
else result.errors; // [{ path: "/offset", keyword: "type", message: "expected integer, got string" }]
```

`coerce(value)` returns the coerced value. It copies only the paths it changes, returns `value` itself when nothing
changes, and never modifies `value`. A value no rule applies to stays as it is. `parse(value)` coerces, then checks:
`{ ok: true, value }` with the coerced value, or `{ ok: false, errors }` with the errors of the coerced value.

Three passes run in order:

1. **Optional nulls.** A `null` in an optional property whose schema rejects `null` is dropped, as if omitted.
2. **Conversions**, ported from TypeBox 1.3.27's `Value.Convert` and keyed on JSON Schema keywords (the first that
   applies to a schema): `$ref` follows the reference; `const` and `enum` take the member the value converts to;
   `anyOf`/`oneOf` keep a value one branch accepts, else take the first branch's conversion the whole schema
   accepts; `allOf` converts with each member in turn; then by `type`:
   - `string`: numbers and booleans to their text, `null` to `"null"`.
   - `number`: numeric strings (`""` is 0), `"true"`/`"false"`, booleans to 1/0, `null` to 0.
   - `integer`: as `number`, then truncated (`"3.5"` and `3.5` become 3).
   - `boolean`: `"true"`/`"false"` (any case), `"1"`/`"0"`, 1/0, `null` to `false`.
   - `null`: `"null"`, `"undefined"`, `""`, `"0"`, 0 and `false`.
   - `bigint`: integer strings (`"12"`, `"12n"`; `"12.9"` truncated), numbers truncated, `"true"`/`"false"` and
     booleans to 1n/0n, `null` to 0n.
   - `undefined`: `"undefined"`, `"null"`, `""`, `"0"`, 0, 0n, `false` and `null`.
   - `array`: a single value becomes a one-item array, then each item converts; a tuple (`prefixItems` or an `items`
     array) converts its items and never wraps.
   - `object`: each property converts by `properties`, `patternProperties` or `additionalProperties`.
3. **Primitive coercion by type**, as Ajv's `coerceTypes`, for what pass 2 leaves (type arrays such as
   `["integer", "null"]`): numbers from numeric strings and booleans, booleans from `"true"`/`"false"` and 1/0,
   strings from numbers and booleans, `null` from `""`, 0 and `false`, and `null` to `""`, 0 or `false`. A value that
   already has one of a type array's types stays.

Where passes 2 and 3 disagree, pass 2 wins: `null` for a required string becomes `"null"`, not `""`. A union's
branches convert in order and only until one is accepted; a union node that also declares properties converts them into
each branch's candidate before checking it. A recursive schema (a tree through `$ref`) that meets a value it cannot
convert leaves the value as it is, so `check` reports it, and results through a `$ref` are reused within one call, so a
recursive union does not convert (or explain) the same child once per branch.

Pass 1 drops optional nulls inside the values of `properties`, `patternProperties` and `additionalProperties` alike; a
pattern or additional key itself is never dropped. Items past a draft-7 `items` array (`additionalItems`) are not
coerced by any pass.

### Values

- An optional property whose value is `undefined` counts as absent, as in TypeBox. A required property set to
  `undefined` is present: valid when its schema takes `undefined` (`Type.Undefined()` in it, `Type.Unknown()`,
  `Type.Any()`), else missing.
- `{ type: "bytes", minLength, maxLength }` matches a `Uint8Array` of that length, an extension for values that never
  pass through JSON.
- `{ type: "bigint" }` (TypeBox's `Type.BigInt`) matches a `bigint`. The number keywords (`minimum`, `maximum`,
  `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`) apply to numbers and bigints alike, with bounds of either kind,
  as in TypeBox.
- `{ type: "undefined" }` (TypeBox's `Type.Undefined`) matches `undefined`.
- `equal(a, b)` is JSON equality as `const`, `enum` and `uniqueItems` compare (TypeBox's `Value.Equal`).

## Supported keywords

- Every validation keyword of drafts 2020-12 and 7, including draft 7's `dependencies` and `items` arrays with
  `additionalItems`.
- `$id`, `$anchor`, `$ref` (local, by anchor, relative and remote), `$dynamicRef` and `$dynamicAnchor`.
- `unevaluatedProperties` and `unevaluatedItems`.
- `pattern` and `patternProperties` are ECMAScript regular expressions with the `u` flag.
- Not supported: meta-schemas that switch vocabularies on or off (`$vocabulary`), `contentMediaType` and
  `contentEncoding` assertions (optional in the spec), and draft 2019-09's `$recursiveRef`.
