import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import fs from 'node:fs/promises'
import { delay, http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type HealthCheckLogContext,
  type HealthCheckProgress,
  type HealthCheckResult,
  type Provider,
  checkModels,
  formatHealthSummary,
  postChatCompletion,
  writeHealthCheckLog,
} from './health-check'
import { createTempDirectory, type TempDirectory } from '../test/helpers/temp-agent'
import { server } from '../test/setup'
import type { Env } from './env'
import { DEFAULT_PROVIDER_ID } from './settings'

const PROVIDER: Provider = {
  baseUrl: 'https://router.requesty.ai/v1',
  apiKey: 'test-key',
}

const completionsEndpoint = 'https://router.requesty.ai/v1/chat/completions'

const CHAT_BODY = {
  model: 'requesty/test-model',
  messages: [{ role: 'user', content: 'Say OK' }],
}

const positiveStreamChunk = { choices: [{ delta: { content: 'OK' } }] }

describe('postChatCompletion', () => {
  it('returns ok for response with non-empty choices', async () => {
    server.use(
      http.post(completionsEndpoint, () => {
        return sseResponse([positiveStreamChunk])
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(result.ok).toBe(true)
  })

  it('returns failure for HTTP error', async () => {
    server.use(
      http.post(completionsEndpoint, () => {
        return HttpResponse.text('bad gateway', {
          status: 502,
          statusText: 'Bad Gateway',
        })
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(result).toMatchObject({
      ok: false,
      error: 'HTTP 502 Bad Gateway: bad gateway',
    })
  })

  it('returns failure for HTTP error with empty response body', async () => {
    server.use(
      http.post(completionsEndpoint, () => {
        return HttpResponse.text('', {
          status: 502,
          statusText: 'Bad Gateway',
        })
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(result).toMatchObject({
      ok: false,
      error: 'HTTP 502 Bad Gateway',
    })
  })

  it('returns failure when response body cannot be read', async () => {
    server.use(
      http.post(completionsEndpoint, () => {
        const stream = new ReadableStream({
          start(controller) {
            controller.error(new Error('body stream errored'))
          },
        })
        return new Response(stream, { status: 502, statusText: 'Bad Gateway' })
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(result).toMatchObject({
      ok: false,
      error: 'HTTP 502 Bad Gateway',
    })
  })

  it('returns failure when successful response body is not valid SSE', async () => {
    server.use(
      http.post(completionsEndpoint, () => {
        return sseRawResponse('not json')
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(result).toMatchObject({
      ok: false,
      error: 'Stream ended without content',
    })
  })

  it('returns failure for stream with only empty choices chunks', async () => {
    server.use(
      http.post(completionsEndpoint, () => {
        return sseResponse([{ choices: [] }])
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(result).toMatchObject({
      ok: false,
      error: 'Stream ended without content',
    })
  })

  it('returns failure for stream with malformed choices chunk', async () => {
    server.use(
      http.post(completionsEndpoint, () => {
        return sseResponse([{ choices: 'not-an-array' }])
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(result).toMatchObject({
      ok: false,
      error: 'Stream ended without content',
    })
  })

  it('sends bearer token', async () => {
    let authorizationHeader: string | null = null
    server.use(
      http.post(completionsEndpoint, ({ request }) => {
        authorizationHeader = request.headers.get('authorization')
        return sseResponse([positiveStreamChunk])
      }),
    )

    await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(authorizationHeader).toBe('Bearer test-key')
  })

  it('sends model in request body', async () => {
    let requestBody: unknown
    server.use(
      http.post(completionsEndpoint, async ({ request }) => {
        requestBody = await request.json()
        return sseResponse([positiveStreamChunk])
      }),
    )

    await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(requestBody).toMatchObject({ model: 'requesty/test-model' })
  })

  it('sends stream:true in request body', async () => {
    let requestBody: unknown
    server.use(
      http.post(completionsEndpoint, async ({ request }) => {
        requestBody = await request.json()
        return sseResponse([positiveStreamChunk])
      }),
    )

    await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(requestBody).toMatchObject({ stream: true })
  })

  it('sends Accept: text/event-stream header', async () => {
    let acceptHeader: string | null = null
    server.use(
      http.post(completionsEndpoint, ({ request }) => {
        acceptHeader = request.headers.get('accept')
        return sseResponse([positiveStreamChunk])
      }),
    )

    await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(acceptHeader).toBe('text/event-stream')
  })

  it('returns ok after the first content chunk of a multi-chunk stream', async () => {
    server.use(
      http.post(completionsEndpoint, () => {
        return sseResponse([
          { choices: [{ delta: { role: 'assistant' } }] },
          { choices: [{ delta: { content: 'OK' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ])
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(result.ok).toBe(true)
  })

  it('returns ok without requiring a [DONE] marker', async () => {
    server.use(
      http.post(completionsEndpoint, () => {
        return sseRawResponse(`data: ${JSON.stringify(positiveStreamChunk)}\n\n`)
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(result.ok).toBe(true)
  })

  it('returns failure when stream ends with [DONE] and no content chunk', async () => {
    server.use(
      http.post(completionsEndpoint, () => {
        return sseRawResponse('data: [DONE]\n\n')
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(result).toMatchObject({
      ok: false,
      error: 'Stream ended without content',
    })
  })

  it('returns failure when stream body is empty', async () => {
    server.use(
      http.post(completionsEndpoint, () => {
        return sseRawResponse('')
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(result).toMatchObject({
      ok: false,
      error: 'Stream ended without content',
    })
  })

  it('returns failure for a non-timeout network error', async () => {
    server.use(
      http.post(completionsEndpoint, () => {
        return HttpResponse.error()
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(result).toMatchObject({ ok: false })
    expect(result.ok).toBe(false)
    expect(result.error).not.toMatch(/^Timed out/)
  })

  it('returns failure for stream emitting an error object without content', async () => {
    server.use(
      http.post(completionsEndpoint, () => {
        return sseResponse([{ error: { message: 'upstream blew up' } }])
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(result).toMatchObject({
      ok: false,
      error: 'Stream ended without content',
    })
  })

  it('retries timeout failures', async () => {
    let requestCount = 0
    server.use(
      http.post(completionsEndpoint, async () => {
        requestCount++
        await delay(50)
        return sseResponse([positiveStreamChunk])
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY, {
      timeoutMs: 1,
      retries: 1,
      retryDelayMs: 3,
    })

    expect(result).toMatchObject({
      ok: false,
      error: 'Timed out after 2 attempt(s); per-attempt timeout is 0.001s',
    })
    expect(requestCount).toBe(2)
  })

  it('retries timeout failures without delay', async () => {
    let requestCount = 0
    server.use(
      http.post(completionsEndpoint, async () => {
        requestCount++
        await delay(50)
        return sseResponse([positiveStreamChunk])
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY, {
      timeoutMs: 1,
      retries: 1,
      retryDelayMs: 0,
    })

    expect(result).toMatchObject({
      ok: false,
      error: 'Timed out after 2 attempt(s); per-attempt timeout is 0.001s',
    })
    expect(requestCount).toBe(2)
  })
})

describe('checkModels', () => {
  it('calls basic completion check once per model', async () => {
    const requestBodies: unknown[] = []
    server.use(
      http.post(completionsEndpoint, async ({ request }) => {
        requestBodies.push(await request.json())
        return sseResponse([positiveStreamChunk])
      }),
    )
    const models = [createModel({ id: 'requesty/model-a' }), createModel({ id: 'requesty/model-b' })]

    await checkModels(PROVIDER, models, false)

    expect(requestBodies).toMatchSnapshot()
  })

  it('calls basic and reasoning/tool check for reasoning models', async () => {
    const requestBodies: unknown[] = []
    server.use(
      http.post(completionsEndpoint, async ({ request }) => {
        requestBodies.push(await request.json())
        return sseResponse([positiveStreamChunk])
      }),
    )
    const models = [createModel({ id: 'requesty/reasoning-model', reasoning: true })]

    await checkModels(PROVIDER, models, true)

    expect(requestBodies).toMatchSnapshot()
  })

  it('returns expected response for failed reasoning/tool check', async () => {
    let requestNumber = 0
    server.use(
      http.post(completionsEndpoint, () => {
        requestNumber++
        if (requestNumber > 1) {
          return HttpResponse.text('BAM', { status: 418 })
        }
        return sseResponse([positiveStreamChunk])
      }),
    )
    const models = [createModel({ id: 'requesty/reasoning-model', reasoning: true })]

    const results = await checkModels(PROVIDER, models, true)

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error: "Reasoning/tool check failed: HTTP 418 I'm a Teapot: BAM",
          modelId: 'requesty/reasoning-model',
          ok: false,
        }),
      ]),
    )
  })

  it('does not call reasoning/tool check for non-reasoning models', async () => {
    const requestBodies: unknown[] = []
    server.use(
      http.post(completionsEndpoint, async ({ request }) => {
        requestBodies.push(await request.json())
        return sseResponse([positiveStreamChunk])
      }),
    )
    const models = [createModel({ id: 'requesty/non-reasoning-model', reasoning: false })]

    await checkModels(PROVIDER, models, true)

    expect(requestBodies).toHaveLength(1)
    expect(requestBodies[0]).toMatchObject({ model: 'requesty/non-reasoning-model' })
  })

  it('does not call reasoning/tool check when basic check fails', async () => {
    const requestBodies: unknown[] = []
    server.use(
      http.post(completionsEndpoint, async ({ request }) => {
        requestBodies.push(await request.json())
        return HttpResponse.text('model failed', { status: 500, statusText: 'Internal Server Error' })
      }),
    )
    const models = [createModel({ id: 'requesty/failing-model', reasoning: true })]

    const results = await checkModels(PROVIDER, models, true)

    expect(requestBodies).toHaveLength(1)
    expect(results[0]).toMatchObject({
      modelId: 'requesty/failing-model',
      ok: false,
    })
  })

  it('returns result objects with modelId', async () => {
    server.use(
      http.post(completionsEndpoint, () => {
        return sseResponse([positiveStreamChunk])
      }),
    )
    const models = [createModel({ id: 'requesty/model-a' }), createModel({ id: 'requesty/model-b' })]

    const results = await checkModels(PROVIDER, models, false)

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelId: 'requesty/model-a' }),
        expect.objectContaining({ modelId: 'requesty/model-b' }),
      ]),
    )
  })

  it('reports progress after each model finishes', async () => {
    server.use(
      http.post(completionsEndpoint, async ({ request }) => {
        const body = (await request.json()) as { model: string }
        if (body.model === 'requesty/model-b') {
          return HttpResponse.text('model failed', { status: 500, statusText: 'Internal Server Error' })
        }
        return sseResponse([positiveStreamChunk])
      }),
    )
    const models = [
      createModel({ id: 'requesty/model-a' }),
      createModel({ id: 'requesty/model-b' }),
      createModel({ id: 'requesty/model-c' }),
    ]
    const progressEvents: HealthCheckProgress[] = []

    await checkModels(PROVIDER, models, false, {
      concurrency: 1,
      onProgress: progress => progressEvents.push(progress),
    })

    expect(progressEvents).toEqual([
      {
        completed: 1,
        total: 3,
        modelId: 'requesty/model-a',
      },
      {
        completed: 2,
        total: 3,
        modelId: 'requesty/model-b',
      },
      {
        completed: 3,
        total: 3,
        modelId: 'requesty/model-c',
      },
    ])
  })

  it('does not report progress when there are no models', async () => {
    const progressEvents: Array<unknown> = []

    await checkModels(PROVIDER, [], false, { onProgress: progress => progressEvents.push(progress) })

    expect(progressEvents).toEqual([])
  })

  it('respects parameterized concurrency', async () => {
    let activeRequests = 0
    let maxActiveRequests = 0
    server.use(
      http.post(completionsEndpoint, async () => {
        activeRequests++
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
        await delay(50)
        activeRequests--
        return sseResponse([positiveStreamChunk])
      }),
    )
    const models = [
      createModel({ id: 'requesty/model-a' }),
      createModel({ id: 'requesty/model-b' }),
      createModel({ id: 'requesty/model-c' }),
      createModel({ id: 'requesty/model-d' }),
    ]

    await checkModels(PROVIDER, models, false, { concurrency: 2 })

    expect(maxActiveRequests).toBeLessThanOrEqual(2)
  })

  it('continues processing queued models after failures', async () => {
    server.use(
      http.post(completionsEndpoint, async ({ request }) => {
        const body = (await request.json()) as { model: string }
        await delay(50)
        if (body.model === 'requesty/model-b') {
          return HttpResponse.text('model failed', { status: 500, statusText: 'Internal Server Error' })
        }
        return sseResponse([positiveStreamChunk])
      }),
    )
    const models = [
      createModel({ id: 'requesty/model-a' }),
      createModel({ id: 'requesty/model-b' }),
      createModel({ id: 'requesty/model-c' }),
      createModel({ id: 'requesty/model-d' }),
    ]

    const results = await checkModels(PROVIDER, models, false, { concurrency: 2 })

    expect(results).toHaveLength(4)
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelId: 'requesty/model-a', ok: true }),
        expect.objectContaining({ modelId: 'requesty/model-b', ok: false }),
        expect.objectContaining({ modelId: 'requesty/model-c', ok: true }),
        expect.objectContaining({ modelId: 'requesty/model-d', ok: true }),
      ]),
    )
  })
})

describe('health summary and log output', () => {
  let tempDirectory: TempDirectory
  const envPrototype: Env = {
    health_check_log_path: '',
    models_json_path: '',
    settings_path: '',
  }
  const logContext: HealthCheckLogContext = {
    providerId: DEFAULT_PROVIDER_ID,
    bannedModels: [],
  }

  beforeEach(async () => {
    tempDirectory = await createTempDirectory()
  })

  afterEach(async () => {
    await tempDirectory.clean()
  })

  it('formats summaries', () => {
    const allPassedResults = [
      createHealthCheckResult({ modelId: 'requesty/model-a', ok: true }),
      createHealthCheckResult({ modelId: 'requesty/model-b', ok: true }),
    ]
    const partialFailureResults = [
      createHealthCheckResult({ modelId: 'requesty/model-a', ok: true }),
      createHealthCheckResult({
        modelId: 'requesty/failing-model',
        ok: false,
        error: 'HTTP 500 Internal Server Error',
      }),
    ]
    const allFailedResults = [
      createHealthCheckResult({ modelId: 'requesty/model-a', ok: false, error: 'first failure' }),
      createHealthCheckResult({ modelId: 'requesty/model-b', ok: false, error: 'second failure' }),
    ]

    const summaries = {
      allPassed: formatHealthSummary(allPassedResults),
      partialFailure: formatHealthSummary(partialFailureResults),
      allFailed: formatHealthSummary(allFailedResults),
    }

    expect(summaries).toMatchSnapshot()
  })

  it('writes log file', async () => {
    const partialFailureResults = [
      createHealthCheckResult({ modelId: 'requesty/model-a', ok: true }),
      createHealthCheckResult({
        modelId: 'requesty/failing-model',
        ok: false,
        error: 'HTTP 500 Internal Server Error',
      }),
      createHealthCheckResult({
        modelId: 'requesty/failing-model-unknown-error',
        ok: false,
      }),
    ]
    const env: Env = { ...envPrototype, health_check_log_path: tempDirectory.healthCheckLogPath }

    writeHealthCheckLog(PROVIDER, partialFailureResults, { added: [], removed: [] }, logContext, env)

    const log = await fs.readFile(tempDirectory.healthCheckLogPath, 'utf8')
    expect(normalizeHealthCheckLog(log)).toMatchSnapshot()
  })

  it('writes log file without any errors', async () => {
    const successfulResults = [
      createHealthCheckResult({ modelId: 'requesty/model-a', ok: true }),
      createHealthCheckResult({ modelId: 'requesty/model-b', ok: true }),
    ]
    const env: Env = { ...envPrototype, health_check_log_path: tempDirectory.healthCheckLogPath }

    writeHealthCheckLog(PROVIDER, successfulResults, { added: [], removed: [] }, logContext, env)

    const log = await fs.readFile(tempDirectory.healthCheckLogPath, 'utf8')
    expect(normalizeHealthCheckLog(log)).toMatchSnapshot()
  })

  it('writes banned models into the log', async () => {
    const results = [createHealthCheckResult({ modelId: 'requesty/model-a', ok: true })]
    const env: Env = { ...envPrototype, health_check_log_path: tempDirectory.healthCheckLogPath }
    const contextWithBans: HealthCheckLogContext = {
      ...logContext,
      bannedModels: ['requesty/unstable-model', 'requesty/another-unstable'],
    }

    writeHealthCheckLog(PROVIDER, results, { added: [], removed: [] }, contextWithBans, env)

    const log = await fs.readFile(tempDirectory.healthCheckLogPath, 'utf8')
    expect(normalizeHealthCheckLog(log)).toMatchSnapshot()
  })

  it('writes added and removed models into the log', async () => {
    const results = [createHealthCheckResult({ modelId: 'requesty/model-a', ok: true })]
    const env: Env = { ...envPrototype, health_check_log_path: tempDirectory.healthCheckLogPath }

    writeHealthCheckLog(
      PROVIDER,
      results,
      { added: ['requesty/model-a', 'requesty/model-new'], removed: ['requesty/model-old'] },
      logContext,
      env,
    )

    const log = await fs.readFile(tempDirectory.healthCheckLogPath, 'utf8')
    expect(normalizeHealthCheckLog(log)).toMatchSnapshot()
  })
})

function createHealthCheckResult(overrides: Partial<HealthCheckResult> = {}): HealthCheckResult {
  return {
    modelId: 'requesty/model',
    ok: true,
    latencyMs: 123,
    ...overrides,
  }
}

function normalizeHealthCheckLog(log: string): string {
  return log.replace(/^Timestamp: .+$/m, 'Timestamp: <timestamp>')
}

function createModel(overrides: Partial<ProviderModelConfig> = {}): ProviderModelConfig {
  return {
    id: 'requesty/model',
    name: 'Requesty Model',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
    },
    contextWindow: 128000,
    maxTokens: 4096,
    ...overrides,
  }
}

function sseBody(chunks: unknown[]): string {
  return [...chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join('')
}

function sseRawResponse(body: string) {
  const encoded = new TextEncoder().encode(body)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (encoded.length > 0) {
        controller.enqueue(encoded)
      }
      controller.close()
    },
  })
  return new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream' } })
}

function sseResponse(chunks: unknown[]) {
  return sseRawResponse(sseBody(chunks))
}
