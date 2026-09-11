import { delay, http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { discoverModels, fetchApiUsage, type RequestyModel } from './requesty-api'
import { server } from '../test/setup'
import { ZodError } from 'zod'

const providerConfig = {
  baseUrl: 'https://router.requesty.ai/v1',
  apiKey: 'test-key',
}

const modelsEndpoint = 'https://router.requesty.ai/v1/models'

function modelsResponse(data: unknown[]) {
  return HttpResponse.json({ data })
}

describe('discoverModels', () => {
  it('calls GET /models', async () => {
    const models: RequestyModel[] = [{ id: 'Provider 1' }, { id: 'Provider 2' }]

    server.use(
      http.get(modelsEndpoint, () => {
        return modelsResponse(models)
      }),
    )

    const result = await discoverModels(providerConfig)

    const modelIds = models.map(p => p.id)
    const providerIds = result.map(m => m.id)
    expect(providerIds).toEqual(modelIds)
  })

  it('sends bearer token', async () => {
    let authorizationHeader: string | null = null

    server.use(
      http.get(modelsEndpoint, ({ request }) => {
        authorizationHeader = request.headers.get('authorization')
        return modelsResponse([])
      }),
    )

    await discoverModels(providerConfig)

    expect(authorizationHeader).toBe('Bearer test-key')
  })

  it('throws on HTTP error', async () => {
    server.use(
      http.get(modelsEndpoint, () => {
        return HttpResponse.json({ error: 'Requesty unavailable' }, { status: 503, statusText: 'Service Unavailable' })
      }),
    )

    const discover = () => discoverModels(providerConfig)

    await expect(discover).rejects.toThrow('HTTP 503 Service Unavailable')
  })

  it('validates malformed response', async () => {
    server.use(
      http.get(modelsEndpoint, () => {
        return HttpResponse.json({ data: {} })
      }),
    )

    const discover = () => discoverModels(providerConfig)

    await expect(discover).rejects.toThrow()
  })

  it('skips invalid model entries', async () => {
    server.use(
      http.get(modelsEndpoint, () => {
        return modelsResponse([
          { id: 'requesty/valid-model', name: 'Valid Model' },
          { id: '' },
          { name: 'Missing ID' },
          null,
        ])
      }),
    )

    const models = await discoverModels(providerConfig)

    expect(models).toHaveLength(1)
    expect(models[0]?.id).toBe('requesty/valid-model')
  })

  it('throws on timeout', async () => {
    server.use(
      http.get(modelsEndpoint, async () => {
        await delay(5)
        return HttpResponse.json({ data: {} })
      }),
    )

    const fetch = () => discoverModels(providerConfig, { timeoutMs: 5 })

    await expect(fetch).rejects.toThrow('The operation was aborted due to timeout')
  })

  it('maps Requesty model fields', async () => {
    server.use(
      http.get(modelsEndpoint, () => {
        return modelsResponse([
          {
            id: 'requesty/mapped-model',
            name: 'Mapped Model',
            supports_reasoning: true,
            supports_vision: true,
            input_price: 0.000001,
            output_price: 0.000002,
            cached_price: 0.0000003,
            caching_price: 0.0000004,
            context_window: 200000,
            max_output_tokens: 8192,
          },
        ])
      }),
    )

    const models = await discoverModels(providerConfig)

    expect(models).toEqual([
      {
        id: 'requesty/mapped-model',
        name: 'Mapped Model',
        reasoning: true,
        input: ['text', 'image'],
        cost: {
          input: 1,
          output: 2,
          cacheRead: 0.3,
          cacheWrite: 0.4,
        },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ])
  })

  it('uses defaults for optional Requesty model fields', async () => {
    server.use(
      http.get(modelsEndpoint, () => {
        return modelsResponse([{ id: 'requesty/default-model' }])
      }),
    )

    const models = await discoverModels(providerConfig)

    expect(models).toEqual([
      {
        id: 'requesty/default-model',
        name: 'requesty/default-model',
        reasoning: false,
        input: ['text'],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ])
  })

  it('rounds prices to 2 decimal places', async () => {
    server.use(
      http.get(modelsEndpoint, () => {
        return modelsResponse([
          {
            id: 'requesty/rounded-down',
            input_price: 0.0000012341,
            output_price: 0.0000012345,
          },
          {
            id: 'requesty/rounded-up',
            input_price: 0.0000012349,
            output_price: 0.0000012346,
          },
        ])
      }),
    )

    const models = await discoverModels(providerConfig)

    expect(models[0]?.cost.input).toBe(1.234)
    expect(models[0]?.cost.output).toBe(1.234)
    expect(models[1]?.cost.input).toBe(1.235)
    expect(models[1]?.cost.output).toBe(1.235)
  })
})

describe('fetchApiUsage', () => {
  const manageEndpoint = 'https://api-v2.requesty.ai/v1/manage/apikey/self'

  function apiKeySelfResponse(data: Record<string, unknown>) {
    return HttpResponse.json(data)
  }

  it('calls GET /manage/apikey/self', async () => {
    let calledUrl: string | null = null
    server.use(
      http.get(manageEndpoint, ({ request }) => {
        calledUrl = request.url
        return apiKeySelfResponse({ name: 'Playground', monthly_spend: '63.545944565', monthly_limit: '150' })
      }),
    )

    await fetchApiUsage(providerConfig)

    expect(calledUrl).toBe(manageEndpoint)
  })

  it('sends bearer token', async () => {
    let authorizationHeader: string | null = null
    server.use(
      http.get(manageEndpoint, ({ request }) => {
        authorizationHeader = request.headers.get('authorization')
        return apiKeySelfResponse({ name: 'Playground', monthly_spend: '0', monthly_limit: '0' })
      }),
    )

    await fetchApiUsage(providerConfig)

    expect(authorizationHeader).toBe('Bearer test-key')
  })

  it('returns parsed name, monthlySpend and monthlyLimit', async () => {
    server.use(
      http.get(manageEndpoint, () => {
        return apiKeySelfResponse({ name: 'Playground', monthly_spend: '63.545944565', monthly_limit: '150' })
      }),
    )

    const info = await fetchApiUsage(providerConfig)

    expect(info).toEqual({ name: 'Playground', monthlySpend: 63.545944565, monthlyLimit: 150 })
  })

  it('parses unlimited limit (0) as 0', async () => {
    server.use(
      http.get(manageEndpoint, () => {
        return apiKeySelfResponse({ name: 'Unlimited', monthly_spend: '12.34', monthly_limit: '0' })
      }),
    )

    const info = await fetchApiUsage(providerConfig)

    expect(info).toEqual({ name: 'Unlimited', monthlySpend: 12.34, monthlyLimit: 0 })
  })

  it('throws on HTTP error', async () => {
    server.use(
      http.get(manageEndpoint, () => {
        return HttpResponse.json({ error: 'Unauthorized' }, { status: 401, statusText: 'Unauthorized' })
      }),
    )

    const fetch = () => fetchApiUsage(providerConfig)

    await expect(fetch).rejects.toThrow('HTTP 401 Unauthorized')
  })

  it('throws on malformed response', async () => {
    server.use(
      http.get(manageEndpoint, () => {
        return apiKeySelfResponse({ name: 'Playground' })
      }),
    )

    const fetch = () => fetchApiUsage(providerConfig)

    await expect(fetch).rejects.toThrow(ZodError)
  })

  it('throws on timeout', async () => {
    server.use(
      http.get(manageEndpoint, async () => {
        await delay(50)
        return apiKeySelfResponse({ name: 'Playground' })
      }),
    )

    const fetch = () => fetchApiUsage(providerConfig, { timeoutMs: 5 })

    await expect(fetch).rejects.toThrow('The operation was aborted due to timeout')
  })
})
