import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'

const DEFAULT_CONTEXT_WINDOW = 128000
const DEFAULT_MAX_TOKENS = 4096

const RequestyModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    supports_reasoning: z.boolean().optional(),
    supports_vision: z.boolean().optional(),
    input_price: z.number().optional().nullable(),
    output_price: z.number().optional().nullable(),
    cached_price: z.number().optional().nullable(),
    caching_price: z.number().optional().nullable(),
    context_window: z.number().optional().nullable(),
    max_output_tokens: z.number().optional().nullable(),
  })
  .catchall(z.unknown())

export type RequestyModel = z.infer<typeof RequestyModelSchema>

const ListModelsResponseSchema = z.object({
  data: z.array(z.unknown()),
})

type Provider = {
  baseUrl: string
  manageBaseUrl?: string
  apiKey: string
}

export async function discoverModels(
  provider: Provider,
  options: { timeoutMs?: number } = {},
): Promise<ProviderModelConfig[]> {
  const timeoutMs = options.timeoutMs ?? 5_000
  const response = await fetch(`${provider.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }

  const rawData = await response.json()
  const payload = ListModelsResponseSchema.parse(rawData)

  return payload.data
    .map(model => RequestyModelSchema.safeParse(model))
    .filter(result => result.success)
    .map(result => result.data)
    .map(model => ({
      id: model.id,
      name: model.name && model.name.length > 0 ? model.name : model.id,
      reasoning: model.supports_reasoning === true,
      input: model.supports_vision === true ? ['text', 'image'] : ['text'],
      cost: {
        input: pricePerMillionTokens(model.input_price),
        output: pricePerMillionTokens(model.output_price),
        cacheRead: pricePerMillionTokens(model.cached_price),
        cacheWrite: pricePerMillionTokens(model.caching_price),
      },
      contextWindow: model.context_window || DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.max_output_tokens || DEFAULT_MAX_TOKENS,
    }))
}

function pricePerMillionTokens(value: number | null | undefined): number {
  const raw = (value ?? 0) * 1_000_000
  return Number(raw.toFixed(3))
}

const ApiKeyInfoSchema = z
  .object({
    name: z.string().min(1),
    monthly_spend: z.coerce.number(),
    monthly_limit: z.coerce.number(),
  })
  .transform(value => ({
    name: value.name,
    monthlySpend: value.monthly_spend,
    monthlyLimit: value.monthly_limit,
  }))

export type ApiKeyInfo = z.infer<typeof ApiKeyInfoSchema>

export async function fetchApiUsage(provider: Provider, options: { timeoutMs?: number } = {}): Promise<ApiKeyInfo> {
  const url = `${provider.manageBaseUrl}/apikey/self`
  const timeoutMs = options.timeoutMs ?? 2_000
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }

  const rawData = await response.json()
  return ApiKeyInfoSchema.parse(rawData)
}
