---
title: "@bastani/atomic-schema"
sidebarTitle: "@bastani/atomic-schema"
description: "Build and validate JSON Schema drafts 2020-12 and 7 without eval, with zero runtime dependencies and optional coercion."
---

JSON Schema builders and validation without `eval`. Each schema compiles once into plain closures, so validation runs without code generation, works under a strict Content Security Policy, and requires zero runtime dependencies.

- Supports JSON Schema drafts 2020-12 and 7.
- Builders return plain JSON Schema objects typed with the values they accept, and compiled checks narrow values to that type.
- Errors include JSON Pointer paths; missing and unknown fields report at the field path.
- Schemas are never mutated, so frozen schemas work.
- Format checks live in an optional subpath import (`@bastani/atomic-schema/formats`).

Atomic validates tool arguments with `@bastani/atomic-schema` (see [Tool parameter schemas](/extensions#tool-parameter-schemas) and [Standalone libraries](/libraries)). Extensions can import it without installing it.

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
const value: unknown = { path: "README.md", mode: "text" };
if (read.check(value)) {
  console.log(value.path); // narrowed to Read
}

read.errors({ offset: 0, extra: true });
// [
//   { path: "/path", keyword: "required", message: "missing" },
//   { path: "/mode", keyword: "required", message: "missing" },
//   { path: "/offset", keyword: "minimum", message: "expected >= 1" },
//   { path: "/extra", keyword: "additionalProperties", message: "unknown field" },
// ]
```

`Read` is a plain JSON Schema object (`{ type: "object", properties: {...}, required: ["path", "mode"], additionalProperties: false }`), ready for tool definitions or `JSON.stringify`. `compile()` accepts any JSON Schema, built or handwritten.

- `check(value)` is the fast boolean path (standalone function, allocation-free for most schemas).
- `errors(value)` returns `ValidationError[]` (`{ path, keyword, message }`), building the error explainer lazily on the first failure.
- `validate(value)` returns `ParseResult<T>` (`{ ok: true; value: T } | { ok: false; errors: ValidationError[] }`) without modifying the input.

### Builders

| Builder | Schema | Inferred type |
| --- | --- | --- |
| `str({ minLength, maxLength, pattern, format })` | `{ type: "string", ... }` | `string` |
| `num({ minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf })`, `int(...)` | `{ type: "number" }`, `{ type: "integer" }` | `number` |
| `bool()`, `nul()`, `unknown()` | `{ type: "boolean" }`, `{ type: "null" }`, `{}` | `boolean`, `null`, `unknown` |
| `lit(value)` | `{ const: value }` | the literal |
| `oneOf(["a", "b"])` | `{ enum: [...] }` | `"a" \| "b"` |
| `obj({ a: str(), b: opt(num()) }, { open })` | closed object (`additionalProperties: false`); `open: true` omits `additionalProperties` | `{ a: string; b?: number }` |
| `arr(items, { minItems, maxItems, uniqueItems })` | `{ type: "array", items }` | `T[]` |
| `tuple([str(), num()])` | `prefixItems`, no additional items | `[string, number]` |
| `map(value)` | `{ type: "object", additionalProperties: value }` | `Record<string, T>` |
| `union([...])` | `{ anyOf: [...] }` | the union |
| `nullable(schema)` | `{ anyOf: [schema, { type: "null" }] }` | `T \| null` |
| `bytes({ minLength, maxLength })` | `{ type: "bytes", ... }` | `Uint8Array` |
| `bigint({ minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf })` | `{ type: "bigint", ... }`, bigint bounds | `bigint` |
| `unsafe<T>(schema)` | `schema` as given (`{}` by default) | `T`, unchecked |
| `recursive<T>(id, (self) => schema)` | `schema` with `$id: id`; `self` is `{ $ref: id }` | `T` |

Every builder accepts `title`, `description`, `examples`, `deprecated`, and `default`.

<Note>
`default` is a schema annotation only—validation and coercion never insert default values into your data.
</Note>

Unions of objects discriminated by a `lit()` property check only the matching branch and report tag errors directly:

```typescript
const Block = union([
  obj({ kind: lit("text"), text: str() }),
  obj({ kind: lit("image"), width: int({ minimum: 0 }) }),
]);
compile(Block).errors({ kind: "video" });
// [{ path: "/kind", keyword: "anyOf", message: 'expected one of ["text","image"]' }]
```

Recursive schemas require an explicit type argument and a unique `id` within the root schema:

```typescript
type Tree = { name: string; children: Tree[] };
const Tree = recursive<Tree>("Tree", (self) => obj({ name: str(), children: arr(self) }));
```

`Static` also infers types for TypeBox 1.x schemas without importing TypeBox (`String`, `Number`, `Integer`, `Boolean`, `Null`, `Literal`, `Array`, `Object` with `Type.Optional`/`Type.Readonly`, `Union`, `Record`, `Enum`, `Tuple`, `BigInt`, `Undefined`, `Unsafe`, `Unknown`, and `Any`). Other TypeBox kinds (`Intersect`, `Cyclic`, `Ref`) and unbranded plain JSON Schemas resolve to `unknown`.

### Options

```typescript
import { formats } from "@bastani/atomic-schema/formats";

const validator = compile(schema, {
  draft: "7",                  // "2020-12" (default) or "7"
  formats,                     // check `format`; omitted keeps `format` as an annotation
  schemas: { "https://example.com/point.json": point }, // external $ref documents by URI
  unresolvedRefs: "reject",    // compile dangling $ref as false instead of throwing (default "throw")
  coerce: true,                // enable coerce() and parse() (see Coercion below)
});
```

`formats` provides 21 checks: `date`, `date-time`, `duration`, `email`, `hostname`, `idn-email`, `idn-hostname`, `ipv4`, `ipv6`, `iri`, `iri-reference`, `json-pointer`, `json-pointer-uri-fragment`, `regex`, `relative-json-pointer`, `time`, `uri`, `uri-reference`, `uri-template`, `url`, and `uuid`. You can also pass a custom format map.

With `unresolvedRefs: "reject"`, a dangling `$ref` compiles as `false` so only values at that location fail with `unresolved reference <ref>` while the rest of the schema validates normally (useful for external MCP tool schemas).

### TypeBox schemas

TypeBox 1.x schemas are plain JSON Schema objects and compile directly. Inside Atomic extensions and SDK apps, import `Type` from `@bastani/atomic/typebox`; in standalone apps, import from `typebox`:

```typescript
import Type from "typebox"; // inside Atomic use: import { Type } from "@bastani/atomic/typebox"

const user = compile(Type.Object({ name: Type.String(), tags: Type.Array(Type.String()) }));
```

TypeBox's `BigInt` and `Undefined` types are supported (see [Values](#values)). JavaScript-only types (`Function`, `Symbol`), refinements, and codecs are not JSON Schema and are not supported.

### Coercion

Pass `{ coerce: true }` to `compile()` to enable `coerce()` and `parse()` for loosely typed inputs such as model tool-call arguments. Without `coerce: true`, neither method is exposed and no coercion code is built; with it, coercion compiles lazily on the first call.

```typescript
const read = compile(Read, { coerce: true });

read.coerce({ path: "a.txt", offset: "10", mode: "text" });
// { path: "a.txt", offset: 10, mode: "text" }

const result = read.parse({ path: "a.txt", offset: "ten", mode: "text" });
if (result.ok) result.value.offset; // number
else result.errors; // [{ path: "/offset", keyword: "type", message: "expected integer, got string" }]
```

`coerce(value)` returns the converted value without mutating `value` (copying only changed paths and returning `value` unchanged when nothing changes). `parse(value)` coerces and then validates, returning `{ ok: true, value }` or `{ ok: false, errors }`.

Coercion runs three passes in order:

1. **Drop optional nulls:** Removes `null` from any optional object property (under `properties`, `patternProperties`, or `additionalProperties`) whose schema rejects `null`, treating the field as omitted.
2. **Schema-driven conversion:** Follows `$ref`, `const`/`enum` (converting to a matching member), `anyOf`/`oneOf` (keeping an already-valid value, or picking the first branch conversion that satisfies the full schema), and `allOf` (converting through each member in order). For typed schemas, converts according to the table below:

| Target type | Accepted conversions (Pass 2) |
| --- | --- |
| `string` | Numbers and booleans convert to text; `null` converts to `"null"`. |
| `number` | Numeric strings (`""` → `0`), `"true"`/`"false"`, booleans (`true` → `1`, `false` → `0`), and `null` (`0`). |
| `integer` | Same as `number`, then truncated toward zero (`"3.5"` and `3.5` → `3`). |
| `boolean` | `"true"`/`"false"` (case-insensitive), `"1"`/`"0"`, `1`/`0`, and `null` (`false`). |
| `null` | `"null"`, `"undefined"`, `""`, `"0"`, `0`, and `false`. |
| `bigint` | Integer strings (`"12"`, `"12n"`, `"12.9"` → `12n`), truncated numbers, `"true"`/`"false"`, booleans (`1n`/`0n`), and `null` (`0n`). |
| `undefined` | `"undefined"`, `"null"`, `""`, `"0"`, `0`, `0n`, `false`, and `null`. |
| `array` | Wraps a non-array value in a single-item array, then converts each item. Tuples (`prefixItems` or draft-7 `items` arrays) convert items in place without wrapping. |
| `object` | Converts each property using `properties`, `patternProperties`, or `additionalProperties`. |

3. **Type-array scalar fallback:** For values untouched by pass 2—most notably multi-type arrays such as `["integer", "null"]`—applies standard scalar conversions (numeric strings/booleans to numbers, `"true"`/`"false"`/`1`/`0` to booleans, numbers/booleans to strings, `""`/`0`/`false` to `null`, and `null` to `""`/`0`/`false`) while leaving any value that already matches one type in the array unchanged.

When passes 2 and 3 differ, pass 2 wins (for example, `null` for a required `string` becomes `"null"`, not `""`). Union branches evaluate in order and reuse recursive `$ref` conversions within a call; unconvertible values remain unchanged so validation reports them cleanly. Items beyond a draft-7 `items` tuple (`additionalItems`) are not coerced.

### Values

- An optional property whose value is `undefined` counts as absent. A required property set to `undefined` counts as present—valid only if its schema accepts `undefined`, and reported as missing otherwise.
- `{ type: "bytes", minLength, maxLength }` matches a `Uint8Array` within those length bounds.
- `{ type: "bigint" }` matches a `bigint`; numeric bounds (`minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`) work with both `number` and `bigint` bounds.
- `{ type: "undefined" }` matches `undefined`.
- `equal(a, b)` tests JSON value equality with the same rules as `const`, `enum`, and `uniqueItems`.

## Supported keywords

- Every validation keyword of drafts 2020-12 and 7, including draft 7's `dependencies` and `items` arrays with `additionalItems`.
- `$id`, `$anchor`, `$ref` (local, anchor, relative, and remote), `$dynamicRef`, and `$dynamicAnchor`.
- `unevaluatedProperties` and `unevaluatedItems`.
- `pattern` and `patternProperties` run as ECMAScript regular expressions with the `u` flag.
- Unsupported keywords: `$vocabulary` meta-schema switches, optional `contentMediaType` and `contentEncoding` assertions, and draft 2019-09's `$recursiveRef`.
