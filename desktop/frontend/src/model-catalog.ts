export type ModelService = { id: string; name: string; api: 'messages' | 'chat-completions'; baseURL: string; apiKeyEnv: string; models: string[] };
export type ModelSelection = { provider: string; model: string };
export type ModelCatalog = {
  model: { api?: string; baseURL?: string; model?: string; apiKeyEnv?: string };
  services?: ModelService[];
  selection?: ModelSelection | null;
  layers: { layer: string; version: string; exists: boolean }[];
  sources: Record<string, string>;
};

export function legacyService(catalog: ModelCatalog): ModelService | null {
  const { api, baseURL, model, apiKeyEnv } = catalog.model;
  if ((api !== 'messages' && api !== 'chat-completions') || !baseURL || !model) return null;
  return { id: 'legacy', name: 'legacy', api, baseURL, apiKeyEnv: apiKeyEnv ?? 'LIGULE_API_KEY', models: [model] };
}
