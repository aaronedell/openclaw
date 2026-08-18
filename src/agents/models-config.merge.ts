/**
 * Merges generated model-provider config with explicit user config and
 * preserved secret fields. Setup and doctor flows use this boundary to update
 * model catalogs without discarding existing credentials.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isNonSecretApiKeyMarker } from "./model-auth-markers.js";
import { resolveCatalogOwnedModelCompat } from "./model-compat-catalog.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

export type ProviderCatalogModelInputPresenceResolver = (
  providerId: string,
  modelId: string,
) => boolean | undefined;

export function normalizeProviderMapKeys<T>(
  providers: Record<string, T> | null | undefined,
): Record<string, T> {
  const normalized: Record<string, T> = {};
  const canonicalKeys = new Set<string>();
  for (const [key, value] of Object.entries(providers ?? {})) {
    const providerKey = normalizeProviderId(key);
    if (!providerKey) {
      continue;
    }
    if (key === providerKey) {
      canonicalKeys.add(providerKey);
      // A prior alias inserted this key at the alias's position. Reinsert it so
      // canonical spelling also controls deterministic provider order.
      delete normalized[providerKey];
      normalized[providerKey] = value;
      continue;
    }
    // Exact canonical spelling wins over aliases regardless of object order.
    // Without one, the later variant wins, matching existing trim-collision behavior.
    if (!canonicalKeys.has(providerKey)) {
      normalized[providerKey] = value;
    }
  }
  return normalized;
}

/** Existing provider config shape that may carry persisted secret/base URL fields. */
export type ExistingProviderConfig = ProviderConfig & {
  apiKey?: string;
  baseUrl?: string;
  api?: string;
};

function getProviderModelId(model: unknown): string {
  if (!model || typeof model !== "object") {
    return "";
  }
  const id = (model as { id?: unknown }).id;
  return normalizeOptionalString(id) ?? "";
}

/** Merges implicit provider models with explicit config while preserving explicit fields. */
export function mergeProviderModels(
  implicit: ProviderConfig,
  explicit: ProviderConfig,
  options?: {
    providerId: string;
    resolveModelInputConfigured?: ProviderCatalogModelInputPresenceResolver;
  },
): ProviderConfig {
  const explicitProvider = options
    ? inheritDiscoveredModelInput({ implicit, explicit, ...options })
    : explicit;
  const implicitModels = Array.isArray(implicit.models) ? implicit.models : [];
  const explicitModels = Array.isArray(explicitProvider.models) ? explicitProvider.models : [];
  const implicitHeaders =
    implicit.headers && typeof implicit.headers === "object" && !Array.isArray(implicit.headers)
      ? implicit.headers
      : undefined;
  const explicitHeaders =
    explicitProvider.headers &&
    typeof explicitProvider.headers === "object" &&
    !Array.isArray(explicitProvider.headers)
      ? explicitProvider.headers
      : undefined;
  if (implicitModels.length === 0) {
    return {
      ...implicit,
      ...explicitProvider,
      ...(implicitHeaders || explicitHeaders
        ? {
            headers: {
              ...implicitHeaders,
              ...explicitHeaders,
            },
          }
        : {}),
    };
  }

  const implicitById = new Map(
    implicitModels
      .map((model) => [getProviderModelId(model), model] as const)
      .filter(([id]) => Boolean(id)),
  );
  const seen = new Set<string>();

  const mergedModels = explicitModels.map((explicitModel) => {
    const id = getProviderModelId(explicitModel);
    if (!id) {
      return explicitModel;
    }
    seen.add(id);
    const implicitModel = implicitById.get(id);
    if (!implicitModel) {
      return explicitModel;
    }

    const contextWindow =
      asPositiveFiniteNumber(explicitModel.contextWindow) ??
      asPositiveFiniteNumber(implicitModel.contextWindow);
    const contextTokens =
      asPositiveFiniteNumber(explicitModel.contextTokens) ??
      asPositiveFiniteNumber(implicitModel.contextTokens);
    const maxTokens =
      asPositiveFiniteNumber(explicitModel.maxTokens) ??
      asPositiveFiniteNumber(implicitModel.maxTokens);
    const compat = resolveCatalogOwnedModelCompat({
      catalogRoute: {
        api: implicitModel.api ?? implicit.api,
        baseUrl: implicitModel.baseUrl ?? implicit.baseUrl,
      },
      catalogCompat: implicitModel.compat,
      configuredRoute: {
        api: explicitModel.api ?? explicitProvider.api ?? implicitModel.api ?? implicit.api,
        baseUrl:
          explicitModel.baseUrl ??
          explicitProvider.baseUrl ??
          implicitModel.baseUrl ??
          implicit.baseUrl,
      },
      configuredCompat: explicitModel.compat,
    });

    return Object.assign(
      {},
      explicitModel,
      {
        input: "input" in explicitModel ? explicitModel.input : implicitModel.input,
        reasoning: `reasoning` in explicitModel ? explicitModel.reasoning : implicitModel.reasoning,
      },
      contextWindow === undefined ? {} : { contextWindow },
      contextTokens === undefined ? {} : { contextTokens },
      maxTokens === undefined ? {} : { maxTokens },
      { compat },
    );
  });

  for (const implicitModel of implicitModels) {
    const id = getProviderModelId(implicitModel);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    mergedModels.push(implicitModel);
  }

  return {
    ...implicit,
    ...explicitProvider,
    ...(implicitHeaders || explicitHeaders
      ? {
          headers: {
            ...implicitHeaders,
            ...explicitHeaders,
          },
        }
      : {}),
    models: mergedModels,
  };
}

/** Restores discovered input only when the source model row omitted that field. */
export function inheritDiscoveredModelInput(params: {
  providerId: string;
  implicit: ProviderConfig;
  explicit: ProviderConfig;
  resolveModelInputConfigured?: ProviderCatalogModelInputPresenceResolver;
}): ProviderConfig {
  const { resolveModelInputConfigured } = params;
  const explicitModels = Array.isArray(params.explicit.models) ? params.explicit.models : [];
  const implicitModels = Array.isArray(params.implicit.models) ? params.implicit.models : [];
  if (!resolveModelInputConfigured || explicitModels.length === 0 || implicitModels.length === 0) {
    return params.explicit;
  }

  const implicitById = new Map(
    implicitModels
      .map((model) => [getProviderModelId(model), model] as const)
      .filter(([id]) => Boolean(id)),
  );
  let mutated = false;
  const models = explicitModels.map((explicitModel) => {
    const id = getProviderModelId(explicitModel);
    const implicitModel = implicitById.get(id);
    if (
      !id ||
      !implicitModel ||
      implicitModel.input === undefined ||
      resolveModelInputConfigured(params.providerId, id) !== false
    ) {
      return explicitModel;
    }
    mutated = true;
    return Object.assign({}, explicitModel, { input: implicitModel.input });
  });

  return mutated ? { ...params.explicit, models } : params.explicit;
}

/** Merges implicit and explicit provider config maps by provider id. */
export function mergeProviders(params: {
  implicit?: Record<string, ProviderConfig> | null;
  explicit?: Record<string, ProviderConfig> | null;
  resolveModelInputConfigured?: ProviderCatalogModelInputPresenceResolver;
}): Record<string, ProviderConfig> {
  const out = normalizeProviderMapKeys(params.implicit);
  for (const [providerKey, explicit] of Object.entries(normalizeProviderMapKeys(params.explicit))) {
    const implicit = out[providerKey];
    out[providerKey] = implicit
      ? mergeProviderModels(implicit, explicit, {
          providerId: providerKey,
          resolveModelInputConfigured: params.resolveModelInputConfigured,
        })
      : explicit;
  }
  return out;
}

function resolveProviderApi(entry: { api?: unknown } | undefined): string | undefined {
  return normalizeOptionalString(entry?.api);
}

function resolveModelApiSurface(entry: { models?: unknown } | undefined): string | undefined {
  if (!Array.isArray(entry?.models)) {
    return undefined;
  }

  const apis = entry.models
    .flatMap((model) => {
      if (!model || typeof model !== "object") {
        return [];
      }
      const api = (model as { api?: unknown }).api;
      const normalized = normalizeOptionalString(api);
      return normalized ? [normalized] : [];
    })
    .toSorted();

  return apis.length > 0 ? JSON.stringify(apis) : undefined;
}

function resolveProviderApiSurface(
  entry: ExistingProviderConfig | ProviderConfig | undefined,
): string | undefined {
  return resolveProviderApi(entry) ?? resolveModelApiSurface(entry);
}

function shouldPreserveExistingApiKey(params: {
  providerKey: string;
  existing: ExistingProviderConfig;
  nextEntry: ProviderConfig;
  secretRefManagedProviders: ReadonlySet<string>;
}): boolean {
  const { providerKey, existing, nextEntry, secretRefManagedProviders } = params;
  const nextApiKey = typeof nextEntry.apiKey === "string" ? nextEntry.apiKey : "";
  if (nextApiKey && isNonSecretApiKeyMarker(nextApiKey)) {
    return false;
  }
  return (
    !secretRefManagedProviders.has(providerKey) &&
    typeof existing.apiKey === "string" &&
    existing.apiKey.length > 0 &&
    !isNonSecretApiKeyMarker(existing.apiKey, { includeEnvVarName: false })
  );
}

function shouldPreserveExistingBaseUrl(params: {
  existing: ExistingProviderConfig;
  nextEntry: ProviderConfig;
}): boolean {
  const { existing, nextEntry } = params;
  if (typeof existing.baseUrl !== "string" || existing.baseUrl.length === 0) {
    return false;
  }

  const existingApi = resolveProviderApiSurface(existing);
  const nextApi = resolveProviderApiSurface(nextEntry);
  return !existingApi || !nextApi || existingApi === nextApi;
}

function isExistingProviderSelfContained(entry: ExistingProviderConfig): boolean {
  if (!Array.isArray(entry.models) || entry.models.length === 0) {
    return true;
  }
  return Boolean(entry.baseUrl?.trim() && entry.apiKey);
}

/** Merges generated provider config with existing secrets safe to preserve. */
export function mergeWithExistingProviderSecrets(params: {
  nextProviders: Record<string, ProviderConfig>;
  existingProviders: Record<string, ExistingProviderConfig>;
  secretRefManagedProviders: ReadonlySet<string>;
}): Record<string, ProviderConfig> {
  const { nextProviders, existingProviders, secretRefManagedProviders } = params;
  const normalizedExistingProviders = normalizeProviderMapKeys(existingProviders);
  const normalizedNextProviders = normalizeProviderMapKeys(nextProviders);

  const mergedProviders: Record<string, ProviderConfig> = {};
  for (const [key, entry] of Object.entries(normalizedExistingProviders)) {
    if (!isExistingProviderSelfContained(entry)) {
      continue;
    }
    mergedProviders[key] = entry;
  }
  for (const [key, newEntry] of Object.entries(normalizedNextProviders)) {
    const existing = normalizedExistingProviders[key];
    if (!existing) {
      mergedProviders[key] = newEntry;
      continue;
    }
    const preserved: Record<string, unknown> = {};
    if (
      shouldPreserveExistingApiKey({
        providerKey: key,
        existing,
        nextEntry: newEntry,
        secretRefManagedProviders,
      })
    ) {
      preserved.apiKey = existing.apiKey;
    }
    if (
      shouldPreserveExistingBaseUrl({
        existing,
        nextEntry: newEntry,
      })
    ) {
      preserved.baseUrl = existing.baseUrl;
    }
    mergedProviders[key] = { ...newEntry, ...preserved };
  }
  return mergedProviders;
}
