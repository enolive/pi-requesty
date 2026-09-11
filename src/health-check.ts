import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import fs from 'node:fs'
import path from 'node:path'
import OpenAI from 'openai'
import type { Stream } from 'openai/streaming'
import { type Env, getEnv } from './env'
import { formatModelsDiffSummary, type ModelsDiff } from './models-json'
import { formatErrorMessage } from './utils'

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

export type HealthCheckStatus = 'ok' | 'warning' | 'error'

export type HealthCheckResult = {
  modelId: string
  status: HealthCheckStatus
  latencyMs: number
  error?: string
}

type ModelCheckResult = Omit<HealthCheckResult, 'modelId'>

export type HealthCheckProgress = {
  completed: number
  total: number
  modelId: string
}

export type HealthCheckLogContext = {
  providerId: string
  bannedModels: string[]
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
  const passed = results.filter(r => r.status === 'ok')
  const warned = results.filter(r => r.status === 'warning')
  const failed = results.filter(r => r.status === 'error')

  const parts = [`${passed.length} OK`]
  if (warned.length > 0) parts.push(`${warned.length} warning${warned.length === 1 ? '' : 's'}`)
  if (failed.length > 0) parts.push(`${failed.length} failed`)

  return `Health check: ${parts.join(', ')}.`
}

export function writeHealthCheckLog(
  provider: Provider,
  results: HealthCheckResult[],
  diff: ModelsDiff,
  context: HealthCheckLogContext,
  envConfig: Env = getEnv(),
): void {
  const passed = results.filter(r => r.status === 'ok')
  const warned = results.filter(r => r.status === 'warning')
  const failed = results.filter(r => r.status === 'error')
  const lines = [
    `Requesty health check log`,
    `Timestamp: ${new Date().toISOString()}`,
    `Provider: ${context.providerId}`,
    `Base URL: ${provider.baseUrl}`,
    `Total: ${results.length}`,
    `Passed: ${passed.length}`,
    `Warnings: ${warned.length}`,
    `Failed: ${failed.length}`,
    `Banned: ${context.bannedModels.length}`,
    ...context.bannedModels.map(id => `- ${id}`),
    '',
    formatModelsDiffSummary(diff),
    '',
  ]

  if (warned.length === 0 && failed.length === 0) {
    lines.push('No failed models.')
  } else {
    if (warned.length > 0) {
      lines.push('Models with warnings:', '')
      for (const result of warned) {
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
    if (failed.length > 0) {
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
      if (isTimeout(err) && attempt < healthCheckOptions.retries) {
        if (healthCheckOptions.retryDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, healthCheckOptions.retryDelayMs))
        }
        continue
      }
      const attempts = attempt + 1
      const status: HealthCheckStatus = isTransient(err) ? 'warning' : 'error'
      return {
        status,
        latencyMs: Date.now() - start,
        error: isTimeout(err)
          ? `Timed out after ${attempts} attempt(s); per-attempt timeout is ${healthCheckOptions.timeoutMs / 1000}s`
          : formatRequestError(err),
      }
    }
  }

  return { status: 'error', latencyMs: Date.now() - start, error: 'Unknown error' }
}

function isTimeout(err: unknown) {
  return err instanceof OpenAI.APIConnectionTimeoutError
}

function isTransient(err: unknown) {
  return err instanceof OpenAI.RateLimitError
}

function formatRequestError(err: unknown) {
  if (err instanceof OpenAI.APIError && err.status !== undefined) {
    // for JSON bodies err.error holds the (unwrapped) parsed payload; for text bodies err.message
    // already includes the status and the raw response text
    const body = err.error ? `: ${JSON.stringify(err.error)}` : `: ${err.message}`
    return `HTTP ${err.status}${body}`
  }
  return formatErrorMessage(err)
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
    if (chunk.choices instanceof Array && chunk.choices.length > 0) {
      return { status: 'ok', latencyMs: Date.now() - start }
    }
  }
  return { status: 'error', latencyMs: Date.now() - start, error: 'Stream ended without content' }
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

  if (basicResult.status !== 'ok' || !model.reasoning || !checkReasoning) {
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

  if (reasoningResult.status !== 'ok') {
    return {
      status: 'error',
      latencyMs: reasoningResult.latencyMs,
      error: `Reasoning/tool check failed: ${reasoningResult.error}`,
    }
  }

  return {
    status: 'ok',
    latencyMs: basicResult.latencyMs + reasoningResult.latencyMs,
  }
}

function resolveHealthCheckOptions(options: HealthCheckOptions): ResolvedHealthCheckOptions {
  return {
    ...defaultHealthCheckOptions,
    ...options,
  }
}
