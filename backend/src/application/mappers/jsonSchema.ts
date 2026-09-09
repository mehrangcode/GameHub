import { z } from 'zod'
import type { JsonSchema } from '../../contracts/dto/games.js'

/**
 * Zod → JSON Schema, for the option schemas we actually publish (S17).
 *
 * `GET /games/:slug` hands the client a machine-readable description of a
 * game's options so the table-creation form can render itself — five games with
 * ~15 options each is a lot of form to hand-write twice, and hand-writing it
 * twice is how the form and the validator drift.
 *
 * Deliberately *not* a general converter and deliberately not a dependency:
 *
 *   - It covers exactly the node types the game catalog uses — object, number,
 *     boolean, string, enum, literal, union-of-literals, tuple, array, plus
 *     `.default()`, `.optional()` and `.nullable()` wrappers.
 *   - It **throws** on anything else. A unit test converts every registry
 *     entry, so an option shape this cannot express fails the build instead of
 *     shipping a silently wrong or truncated schema to the form.
 *
 * The server remains the only authority: this output is for rendering, and
 * `POST /tables` still parses the submitted options with the real Zod schema.
 */

export class UnsupportedSchemaError extends TypeError {
  constructor(node: string, path: string) {
    super(`cannot convert Zod node '${node}' to JSON Schema at '${path || '(root)'}'`)
    this.name = 'UnsupportedSchemaError'
  }
}

export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return convert(schema, '')
}

function convert(schema: z.ZodTypeAny, path: string): JsonSchema {
  // Wrappers first: they decorate an inner type rather than describing one, and
  // JSON Schema expresses them as keywords on the inner node.
  if (schema instanceof z.ZodDefault) {
    return {
      ...convert(schema._def.innerType as z.ZodTypeAny, path),
      default: schema._def.defaultValue() as unknown,
    }
  }
  if (schema instanceof z.ZodOptional) {
    return convert(schema._def.innerType as z.ZodTypeAny, path)
  }
  if (schema instanceof z.ZodNullable) {
    const inner = convert(schema._def.innerType as z.ZodTypeAny, path)
    return { ...inner, nullable: true }
  }
  if (schema instanceof z.ZodEffects) {
    // `.refine()`/`.transform()` — the constraint is not expressible, but the
    // shape underneath is, and a form that renders the shape is still correct.
    return convert(schema._def.schema as z.ZodTypeAny, path)
  }

  if (schema instanceof z.ZodObject) {
    const shape = schema._def.shape() as Record<string, z.ZodTypeAny>
    const properties: Record<string, JsonSchema> = {}
    const required: string[] = []

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convert(value, path ? `${path}.${key}` : key)
      // A field with a default is never required of the caller: omitting it is
      // how you ask for the default.
      if (!value.isOptional()) required.push(key)
    }

    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      // Mirrors `.strict()`: the schema the client renders should refuse the
      // same unknown keys the server will.
      additionalProperties: schema._def.unknownKeys === 'strict' ? false : true,
    }
  }

  if (schema instanceof z.ZodNumber) {
    const out: JsonSchema = { type: isInt(schema) ? 'integer' : 'number' }
    for (const check of schema._def.checks) {
      if (check.kind === 'min') out[check.inclusive ? 'minimum' : 'exclusiveMinimum'] = check.value
      if (check.kind === 'max') out[check.inclusive ? 'maximum' : 'exclusiveMaximum'] = check.value
      if (check.kind === 'multipleOf') out.multipleOf = check.value
    }
    return out
  }

  if (schema instanceof z.ZodString) {
    const out: JsonSchema = { type: 'string' }
    for (const check of schema._def.checks) {
      if (check.kind === 'min') out.minLength = check.value
      if (check.kind === 'max') out.maxLength = check.value
      if (check.kind === 'regex') out.pattern = check.regex.source
      if (check.kind === 'email') out.format = 'email'
      if (check.kind === 'url') out.format = 'uri'
    }
    return out
  }

  if (schema instanceof z.ZodBoolean) return { type: 'boolean' }

  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: [...(schema._def.values as string[])] }
  }

  if (schema instanceof z.ZodLiteral) {
    const value = schema._def.value as unknown
    return { type: jsonTypeOf(value, path), const: value }
  }

  if (schema instanceof z.ZodUnion) {
    const members = schema._def.options as z.ZodTypeAny[]
    // A union of literals is an enum, which is what a form renders as a select.
    // Anything else stays a union and the client picks a widget per branch.
    if (members.every((member) => member instanceof z.ZodLiteral)) {
      return { enum: members.map((member) => (member as z.ZodLiteral<unknown>)._def.value) }
    }
    return { anyOf: members.map((member) => convert(member, path)) }
  }

  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: convert(schema._def.type as z.ZodTypeAny, path) }
  }

  if (schema instanceof z.ZodTuple) {
    const items = schema._def.items as z.ZodTypeAny[]
    return {
      type: 'array',
      items: items.map((item, index) => convert(item, `${path}[${index}]`)),
      minItems: items.length,
      maxItems: items.length,
    }
  }

  if (schema instanceof z.ZodRecord) {
    return {
      type: 'object',
      additionalProperties: convert(schema._def.valueType as z.ZodTypeAny, path),
    }
  }

  throw new UnsupportedSchemaError(schema._def.typeName ?? schema.constructor.name, path)
}

function isInt(schema: z.ZodNumber): boolean {
  return schema._def.checks.some((check) => check.kind === 'int')
}

function jsonTypeOf(value: unknown, path: string): string {
  switch (typeof value) {
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    default:
      throw new UnsupportedSchemaError(`literal(${typeof value})`, path)
  }
}
