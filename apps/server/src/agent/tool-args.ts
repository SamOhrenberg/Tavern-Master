/**
 * Holding a model to the arguments a tool takes. Zod quietly drops keys it does
 * not know, so a call that wrote hpDelta for hp_delta, or quantity for qty,
 * would succeed and do nothing, or less than asked. Here the schema a model is
 * shown says which keys an object takes and no others, and a call that sends
 * another key is refused with its name, which the model can put right.
 *
 * Only objects that list their properties are held to them; records and
 * unions are left as they are.
 */

type Schema = Record<string, unknown>;

const isObject = (v: unknown): v is Schema => !!v && typeof v === 'object' && !Array.isArray(v);

/** The JSON Schema with every object that lists its properties closed to others. */
export function closeSchema(schema: Schema): Schema {
  const out: Schema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && isObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, isObject(v) ? closeSchema(v) : v]),
      );
    } else if (Array.isArray(value)) {
      out[key] = value.map((v) => (isObject(v) ? closeSchema(v) : v));
    } else if (isObject(value) && key !== 'default' && key !== 'const') {
      out[key] = closeSchema(value);
    } else {
      out[key] = value;
    }
  }
  if (out.type === 'object' && isObject(out.properties) && out.additionalProperties === undefined)
    out.additionalProperties = false;
  return out;
}

/** The keys in `input` the schema does not take, as paths like "add[0].quantity". */
export function strayKeys(schema: Schema, input: unknown, path = ''): string[] {
  if (Array.isArray(input)) {
    const items = schema.items;
    return isObject(items) ? input.flatMap((v, i) => strayKeys(items, v, `${path}[${i}]`)) : [];
  }
  const props = schema.properties;
  if (!isObject(input) || !isObject(props) || schema.additionalProperties) return [];
  return Object.entries(input).flatMap(([k, v]) => {
    const at = path ? `${path}.${k}` : k;
    const prop = props[k];
    if (!Object.hasOwn(props, k)) return [at];
    return isObject(prop) ? strayKeys(prop, v, at) : [];
  });
}

/** The refusal a model reads when it sends keys a tool does not take. */
export function strayKeysError(tool: string, schema: Schema, stray: string[]): string {
  const takes = isObject(schema.properties) ? Object.keys(schema.properties) : [];
  return (
    `Invalid arguments: ${tool} does not take ${stray.map((s) => `"${s}"`).join(', ')}. ` +
    `Nothing was done. Its arguments: ${takes.join(', ') || 'none'}.`
  );
}
