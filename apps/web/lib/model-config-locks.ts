import { modelConfigSchema, type ModelConfig } from "@print/shared";

const CONFIG_KEYS = [
  "material",
  "colour",
  "layerHeightUm",
  "infillPct",
  "supports",
  "quantity",
] as const satisfies readonly (keyof ModelConfig)[];

/** Apply a 3MF's locked settings over what the customer chose. A locked layer
 *  height the shop no longer offers (`layerHeights`) is left to the customer's
 *  choice instead, so the model stays quotable. */
export function normalizeModelConfigLocks<T extends Partial<ModelConfig>>(
  config: T,
  model: { defaultConfig?: unknown; lockedConfig?: unknown },
  layerHeights?: readonly number[],
): T {
  if (!model.lockedConfig || typeof model.lockedConfig !== "object") return config;

  const defaults = modelConfigSchema.partial().safeParse(model.defaultConfig ?? {});
  if (!defaults.success) return config;

  const locked = model.lockedConfig as Record<string, unknown>;
  const next: Partial<ModelConfig> = { ...config };
  for (const key of CONFIG_KEYS) {
    if (key === "layerHeightUm" && layerHeights && !layerHeights.includes(defaults.data.layerHeightUm ?? -1)) continue;
    if (locked[key] === true && defaults.data[key] !== undefined && key in config) {
      (next as Record<keyof ModelConfig, ModelConfig[keyof ModelConfig]>)[key] = defaults.data[
        key
      ] as ModelConfig[keyof ModelConfig];
    }
  }
  return next as T;
}
