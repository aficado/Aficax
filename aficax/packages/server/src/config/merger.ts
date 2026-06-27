// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\config\merger.ts
// ConfigMerger: deep-merge configuration objects in precedence order.
//
// Precedence (lowest to highest):
//   1. Built-in defaults (passed in by the caller).
//   2. Global config (`~/.aficax/config.json`).
//   3. Project config (`<cwd>/.aficax/settings.json`).
//   4. Environment variables (`AFICAX_*`).
//   5. CLI flags (the highest-precedence override).
//
// Each call to {@link mergeConfigs} takes a list of layers (lowest
// precedence first) and produces a single object. The merge is purely
// structural: primitive fields are taken from the highest-precedence
// layer that defines them, arrays are REPLACED (not concatenated), and
// nested objects are merged recursively.

/** Any structural value the merger accepts. */
export type MergeValue =
  | string
  | number
  | boolean
  | null
  | readonly MergeValue[]
  | { readonly [key: string]: MergeValue | undefined }
  | undefined;

/**
 * Deep-merge `overrides` onto `base`. Returns a new object; neither
 * input is mutated. Arrays are replaced wholesale; nested objects are
 * merged key-by-key. The `null` and `undefined` cases follow the
 * "highest-precedence wins" rule, with one exception: an explicit
 * `undefined` in a higher layer DROPS the lower-precedence value
 * (used by CLI flags to clear settings).
 */
export function mergeConfigs<T extends MergeValue>(base: T, overrides: MergeValue | undefined): T {
  if (overrides === undefined) return base;
  if (overrides === null) return overrides as T;
  return mergeTwo(base, overrides) as T;
}

function mergeTwo(base: MergeValue, override: MergeValue): MergeValue {
  if (override === undefined) return base;
  if (base === undefined) return override;
  if (base === null) return override;
  if (override === null) return null;
  if (Array.isArray(override)) return override;
  if (Array.isArray(base)) return override;
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: { [key: string]: MergeValue } = { ...base };
    for (const [key, value] of Object.entries(override)) {
      const existing = out[key];
      out[key] = existing === undefined ? value : mergeTwo(existing, value);
    }
    return out;
  }
  return override;
}

function isPlainObject(value: unknown): value is { readonly [key: string]: MergeValue } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reduce a list of layers (lowest precedence first) into a single
 * value. The first layer is used as the seed; each subsequent layer
 * is {@link mergeConfigs}-merged on top.
 */
export function mergeLayers(layers: readonly MergeValue[]): MergeValue {
  if (layers.length === 0) return undefined;
  let acc: MergeValue = layers[0];
  for (let i = 1; i < layers.length; i++) {
    acc = mergeTwo(acc, layers[i]);
  }
  return acc;
}
