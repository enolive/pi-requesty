import type { ProviderConfig, ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { type Env, getEnv } from './env'
import type { DiscoverySettings } from './settings'

const DEFAULT_BASE_URL = 'https://router.requesty.ai/v1'
const DEFAULT_NAME = 'Requesty'

/** Resolves the API key for a provider through Pi's model registry. */
export type GetApiKey = (providerId: string) => Promise<string | undefined>

const ProviderSchema = z
  .object({
    name: z.string().optional(),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    api: z.string().optional(),
    models: z.array(z.object({ id: z.string() }).catchall(z.unknown())).optional(),
  })
  .catchall(z.unknown())

const ModelsJsonSchema = z
  .object({
    providers: z.record(z.string(), ProviderSchema),
  })
  .catchall(z.unknown())

export type ModelsJson = z.infer<typeof ModelsJsonSchema>
type ModelsJsonProvider = z.infer<typeof ProviderSchema>

export type RequestyProvider = ModelsJsonProvider & {
  name: string
  baseUrl: string
  apiKey: string
}

type RequestyConfig = {
  data: ModelsJson
  provider: RequestyProvider
  existingModelIds: string[]
}

export type ModelsDiff = {
  added: string[]
  removed: string[]
}

export async function getRequestyConfig(
  getApiKey: GetApiKey,
  settings: DiscoverySettings,
  envConfig: Env = getEnv(),
): Promise<RequestyConfig> {
  const data = readModelsJson(envConfig)
  const provider = data.providers[settings.providerId]

  if (!provider) {
    throw new Error(`${envConfig.models_json_path} does not define providers.${settings.providerId}`)
  }

  const apiKey = await getApiKey(settings.providerId)
  if (!apiKey) {
    throw new Error(`No API key found for provider ${settings.providerId}`)
  }
  return {
    data,
    existingModelIds: (provider.models ?? []).map(m => m.id),
    provider: {
      ...provider,
      name: nonEmptyString(provider.name) ?? DEFAULT_NAME,
      baseUrl: normalizeBaseUrl(nonEmptyString(provider.baseUrl) ?? DEFAULT_BASE_URL),
      apiKey,
    },
  }
}

export function diffModels(previousIds: string[], nextModels: ProviderModelConfig[]): ModelsDiff {
  const previous = new Set(previousIds)
  const next = new Set(nextModels.map(m => m.id))
  return {
    added: [...next].filter(id => !previous.has(id)).toSorted(),
    removed: [...previous].filter(id => !next.has(id)).toSorted(),
  }
}

export function formatModelsDiffSummary(diff: ModelsDiff): string {
  return [
    diff.added.length === 0 ? 'No added models.' : 'Added models:',
    ...diff.added.map(id => `- ${id}`),
    diff.removed.length === 0 ? 'No removed models.' : 'Removed models:',
    ...diff.removed.map(id => `- ${id}`),
  ].join('\n')
}

export function updateModelsJson(
  data: ModelsJson,
  models: ProviderModelConfig[],
  settings: DiscoverySettings,
  envConfig = getEnv(),
): void {
  const provider = data.providers[settings.providerId]
  const { name, baseUrl, api, apiKey, models: _existingModels, ...passthrough } = provider
  data.providers[settings.providerId] = {
    name,
    baseUrl,
    api,
    apiKey,
    ...passthrough,
    models: models.map(model => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  } satisfies ProviderConfig

  writeModelsJson(data, envConfig)
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function readModelsJson(envConfig: Env = getEnv()): ModelsJson {
  if (!fs.existsSync(envConfig.models_json_path)) {
    throw new Error(`${envConfig.models_json_path} does not exist`)
  }

  const data = JSON.parse(fs.readFileSync(envConfig.models_json_path, 'utf8')) as unknown
  const result = ModelsJsonSchema.safeParse(data)

  if (!result.success) {
    throw new Error(`${envConfig.models_json_path} is invalid: ${z.prettifyError(result.error)}`)
  }

  return result.data
}

function writeModelsJson(data: ModelsJson, envConfig: Env = getEnv()): void {
  fs.mkdirSync(path.dirname(envConfig.models_json_path), { recursive: true })
  const tmpPath = `${envConfig.models_json_path}.tmp`
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.renameSync(tmpPath, envConfig.models_json_path)
}

function nonEmptyString(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined
}
