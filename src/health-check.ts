import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import fs from 'node:fs'
import path from 'node:path'
import OpenAI from 'openai'
import type { Stream } from 'openai/streaming'
import { getEnv, type Env } from './env'
import { formatModelsDiffSummary, type ModelsDiff } from './models-json'

const HEALTH_CHECK_CONCURRENCY = 10
const HEALTH_CHECK_TIMEOUT_MS = 15_000
const HEALTH_CHECK_TIMEOUT_RETRIES = 2
const HEALTH_CHECK_RETRY_DELAY_MS = 500

const defaultHealthCheckOptions = {
  concurrency: HEALTH_CHECK_CONCURRENCY,
  timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
  retries: HEALTH_CHECK_TIMEOUT_RETRIES,
  retryDelayMs: HEALTH_CHECK_RETRY_DELAY_MS,
}

export type Provider = {
  baseUrl: string
  apiKey: string
}

export type HealthCheckResult = {
  modelId: string
  ok: boolean
  latencyMs: number
  error?: string
}

type ModelCheckResult = Omit<HealthCheckResult, 'modelId'>

export type HealthCheckProgress = {
  completed: number
  total: number
  modelId: string
}

export type HealthCheckOptions = {
  concurrency?: number
  timeoutMs?: number
  retries?: number
  retryDelayMs?: number
  onProgress?: (progress: HealthCheckProgress) => void
}

type ResolvedHealthCheckOptions = Required<Omit<HealthCheckOptions, 'onProgress'>> &
  Pick<HealthCheckOptions, 'onProgress'>

export async function checkModels(
  provider: Provider,
  models: ProviderModelConfig[],
  checkReasoning: boolean,
  options: HealthCheckOptions = {},
): Promise<HealthCheckResult[]> {
  const healthCheckOptions = resolveHealthCheckOptions(options)
  const results: HealthCheckResult[] = []
  const queue = [...models]
  const total = models.length
  let active = 0
  let completed = 0

  await new Promise<void>(resolve => {
    function next() {
      while (active < healthCheckOptions.concurrency && queue.length > 0) {
        // note: due to the single-threaded nature of JS, race conditions are not possible here
        const model = queue.shift()!
        active++
        void checkModel(provider, model, checkReasoning, healthCheckOptions).then(result => {
          const healthCheckResult = { modelId: model.id, ...result }
          results.push(healthCheckResult)
          completed++
          healthCheckOptions.onProgress?.({ completed, total, modelId: model.id })
          active--
          if (queue.length === 0 && active === 0) resolve()
          else next()
        })
      }
      if (queue.length === 0 && active === 0) resolve()
    }
    next()
  })

  return results
}

export function formatHealthSummary(results: HealthCheckResult[]): string {
  const passed = results.filter(r => r.ok)
  const failed = results.filter(r => !r.ok)

  if (failed.length === 0) {
    return `Health check: all ${passed.length} OK.`
  }

  const failedModels = failed.map(r => `- ${r.modelId}`).join('\n')

  return `Health check: ${passed.length} OK, ${failed.length} failed:\n${failedModels}\n`
}

export function writeHealthCheckLog(
  provider: Provider,
  results: HealthCheckResult[],
  diff: ModelsDiff,
  envConfig: Env = getEnv(),
): void {
  const passed = results.filter(r => r.ok)
  const failed = results.filter(r => !r.ok)
  const lines = [
    `Requesty health check log`,
    `Timestamp: ${new Date().toISOString()}`,
    `Provider: ${envConfig.provider_id}`,
    `Base URL: ${provider.baseUrl}`,
    `Total: ${results.length}`,
    `Passed: ${passed.length}`,
    `Failed: ${failed.length}`,
    '',
    formatModelsDiffSummary(diff),
    '',
  ]

  if (failed.length === 0) {
    lines.push('No failed models.')
  } else {
    lines.push('Failed models:', '')
    for (const result of failed) {
      lines.push(
        `Model: ${result.modelId}`,
        `Latency: ${result.latencyMs}ms`,
        'Error:',
        result.error || 'Unknown error',
        '',
        '---',
        '',
      )
    }
  }

  fs.mkdirSync(path.dirname(envConfig.health_check_log_path), { recursive: true })
  fs.writeFileSync(envConfig.health_check_log_path, `${lines.join('\n')}\n`, 'utf8')
}

export async function postChatCompletion(
  provider: Provider,
  body: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, 'stream'>,
  options: HealthCheckOptions = {},
): Promise<ModelCheckResult> {
  const healthCheckOptions = resolveHealthCheckOptions(options)
  const start = Date.now()
  const client = createClient(provider, healthCheckOptions)

  for (let attempt = 0; attempt <= healthCheckOptions.retries; attempt++) {
    try {
      const stream = await client.chat.completions.create({
        ...body,
        stream: true,
      })
      return await verifyFirstStreamChunk(stream, start)
    } catch (err) {
      if (err instanceof OpenAI.APIConnectionTimeoutError && attempt < healthCheckOptions.retries) {
        if (healthCheckOptions.retryDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, healthCheckOptions.retryDelayMs))
        }
        continue
      }
      const attempts = attempt + 1
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error:
          err instanceof OpenAI.APIConnectionTimeoutError
            ? `Timed out after ${attempts} attempt(s); per-attempt timeout is ${healthCheckOptions.timeoutMs / 1000}s`
            : formatRequestError(err),
      }
    }
  }

  return { ok: false, latencyMs: Date.now() - start, error: 'Unknown error' }
}

function formatRequestError(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function createClient(provider: Provider, options: ResolvedHealthCheckOptions): OpenAI {
  return new OpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseUrl,
    timeout: options.timeoutMs,
    maxRetries: 0,
  })
}

async function verifyFirstStreamChunk(
  stream: Stream<OpenAI.Chat.Completions.ChatCompletionChunk>,
  start: number,
): Promise<ModelCheckResult> {
  for await (const chunk of stream) {
    if (chunk.choices?.length) {
      // abort before breaking so the request is terminated immediately
      stream.controller.abort()
      return { ok: true, latencyMs: Date.now() - start }
    }
  }
  return { ok: false, latencyMs: Date.now() - start, error: 'Stream ended without content' }
}

async function checkModel(
  provider: Provider,
  model: ProviderModelConfig,
  checkReasoning: boolean,
  options: ResolvedHealthCheckOptions,
): Promise<ModelCheckResult> {
  const basicResult = await postChatCompletion(
    provider,
    {
      model: model.id,
      messages: [{ role: 'user', content: 'Say OK' }],
      max_tokens: 16,
    },
    options,
  )

  if (!basicResult.ok || !model.reasoning || !checkReasoning) {
    return basicResult
  }

  const reasoningResult = await postChatCompletion(
    provider,
    {
      model: model.id,
      messages: [{ role: 'user', content: 'Say OK. Do not call any tools.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'health_check_noop',
            description: 'A no-op tool used only to verify tool compatibility during model health checks.',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
        },
      ],
      reasoning_effort: 'low',
    },
    options,
  )

  if (!reasoningResult.ok) {
    return {
      ok: false,
      latencyMs: reasoningResult.latencyMs,
      error: `Reasoning/tool check failed: ${reasoningResult.error}`,
    }
  }

  return {
    ok: true,
    latencyMs: basicResult.latencyMs + reasoningResult.latencyMs,
  }
}

function resolveHealthCheckOptions(options: HealthCheckOptions): ResolvedHealthCheckOptions {
  return {
    ...defaultHealthCheckOptions,
    ...options,
  }
}
