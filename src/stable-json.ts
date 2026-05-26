/**
 * Output determinism (ISA ISC-62) — stable JSON key ordering.
 *
 * `JSON.stringify` preserves the insertion order of object keys. That makes
 * serialized output only *incidentally* deterministic — it depends on every
 * code path constructing objects in the same order forever. `stableStringify`
 * makes it deterministic *by construction*: object keys are sorted recursively
 * before serialization, so two runs over equal data produce byte-identical JSON
 * regardless of how the objects were built.
 *
 * Arrays keep their order — array order is meaningful data, not key layout.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeysDeep(src[k]);
    return out;
  }
  return value;
}

export function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(sortKeysDeep(value), null, indent);
}
