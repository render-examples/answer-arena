import { createModelGateway } from "@ragtime/composition";
import type { ModelCatalog } from "@ragtime/core";

let catalogCache: { data: ModelCatalog; expires: number } | null = null;

/** Cached OpenRouter catalog shared by `/api/models` and run admission. */
export async function getModelCatalog(): Promise<ModelCatalog> {
  if (catalogCache && catalogCache.expires > Date.now()) {
    return catalogCache.data;
  }
  const gateway = createModelGateway();
  const data = await gateway.catalog();
  catalogCache = { data, expires: Date.now() + 10 * 60 * 1000 };
  return data;
}
