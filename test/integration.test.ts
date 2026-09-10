import fs from 'node:fs/promises'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeCommandContext, createFakePi } from './helpers/fake-pi'
import { createTempDirectory, type TempDirectory } from './helpers/temp-agent'
import { DEFAULT_PROVIDER_ID } from '../src/env'
import { server } from './setup'

const COMMAND_NAME = 'requesty-discover'
const BASE_URL = 'https://router.requesty.ai/v1'

let tempDirectory: TempDirectory

beforeEach(async () => {
  tempDirectory = await createTempDirectory()
  vi.doMock('../src/env', () => ({
    getEnv: () => ({
      models_json_path: tempDirectory?.modelsJsonPath,
      health_check_log_path: tempDirectory?.healthCheckLogPath,
      provider_id: DEFAULT_PROVIDER_ID,
      requesty_base_url: BASE_URL,
      requesty_manage_base_url: '',
      health_check_mode: 'full',
    }),
  }))
})

afterEach(async () => {
  vi.doUnmock('../src/env')
  vi.resetModules()
  await tempDirectory.clean()
})

describe('requesty-models-discover integration', () => {
  const usedAuthKeys: string[] = []

  it('syncs a passing Requesty model into a temp models.json', async () => {
    await writeInitialModelsJson(tempDirectory.modelsJsonPath)
    server.use(
      http.get(`${BASE_URL}/models`, ({ request }) => {
        usedAuthKeys.push(request.headers.get('authorization') ?? '')
        return HttpResponse.json({
          data: [
            {
              id: 'openai/gpt-4.1-mini',
              name: 'GPT 4.1 Mini',
              supports_reasoning: false,
              supports_vision: false,
              input_price: 0.000001, // 1
              output_price: 0.000002, // 2
              cached_price: 0.000003, // 3
              caching_price: 0.000004, // 4
              context_window: 1047576,
              max_output_tokens: 32768,
            },
            {
              id: 'openai/gpt-5.5',
              name: 'GPT 5.5',
              supports_reasoning: true,
              supports_vision: true,
              input_price: 0.000004, // 4
              output_price: 0.000008, // 8
              cached_price: 0.000012, // 12
              caching_price: 0.000016, // 16
              context_window: 1047576,
              max_output_tokens: 32768,
            },
          ],
        })
      }),
      http.post(`${BASE_URL}/chat/completions`, ({ request }) => {
        usedAuthKeys.push(request.headers.get('authorization') ?? '')
        return sseOk()
      }),
    )
    const extension = await import('../src/index')
    const { pi, commands } = createFakePi()
    extension.default(pi)
    const command = commands.get(COMMAND_NAME)
    expect(command).toBeDefined()
    const { ctx, capturedNotifications, capturedModelRefreshes } = createFakeCommandContext({
      knownApiKeys: { [DEFAULT_PROVIDER_ID]: 'integration-test-api-key' },
    })

    await command!.handler('', ctx)

    // four HTTP calls total:
    // 1: read models
    // 2: health check basic model
    // 3+4: health check model with reasoning
    expect(usedAuthKeys).toHaveLength(4)
    const uniqueAuthKeys = [...new Set(usedAuthKeys)]
    expect(uniqueAuthKeys).toEqual(['Bearer integration-test-api-key'])
    const modelsJson = await readJson(tempDirectory.modelsJsonPath)
    expect(modelsJson).toMatchSnapshot()
    const healthCheckLog = await fs.readFile(tempDirectory.healthCheckLogPath, 'utf8')
    expect(healthCheckLog).toContain('Total: 2')
    expect(healthCheckLog).toContain('Passed: 2')
    expect(capturedNotifications).toHaveLength(2)
    expect(capturedNotifications[0]?.type).toBe('info')
    expect(capturedNotifications[0]?.message).toContain(`${COMMAND_NAME}: Discovered 2 Requesty model(s).`)
    expect(capturedNotifications[1]).toEqual({
      type: 'info',
      message: `${COMMAND_NAME}: Updated models.json. New models are available in /model.`,
    })
    expect(capturedModelRefreshes).toEqual([{ allowNetwork: false }])
  })
})

async function writeInitialModelsJson(modelsJsonPath: string): Promise<void> {
  await fs.writeFile(
    modelsJsonPath,
    `${JSON.stringify(
      {
        providers: {
          [DEFAULT_PROVIDER_ID]: {
            name: 'Requesty',
            baseUrl: BASE_URL,
            apiKey: 'api-key-from-models-json-will-be-ignored',
            api: 'openai-completions',
            models: [],
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path, 'utf8')) as unknown
}

function sseOk() {
  const encoded = new TextEncoder().encode(
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' } }] })}\n\ndata: [DONE]\n\n`,
  )
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded)
      controller.close()
    },
  })
  return new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream' } })
}
