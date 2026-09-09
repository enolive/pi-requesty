import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from './env'
import { DEFAULT_PROVIDER_ID } from './env'
import { diffModels, formatModelsDiffSummary, getRequestyConfig, updateModelsJson } from './models-json'
import { createTempDirectory, type TempDirectory } from '../test/helpers/temp-agent'
import { createModelRegistry } from '../test/helpers/fake-pi.ts'

const PROVIDER_ID = DEFAULT_PROVIDER_ID

type TestProvider = Record<string, unknown> & { models?: unknown }
type TestModelsJson = { providers: Record<string, TestProvider> }

describe('getRequestyConfig', () => {
  let tempDirectory: TempDirectory

  beforeEach(async () => {
    tempDirectory = await createTempDirectory()
  })

  afterEach(async () => {
    await tempDirectory.clean()
  })

  it('throws if models.json does not exist', async () => {
    const envConfig = createTestEnv(tempDirectory)
    const registry = createModelRegistry()

    const readConfig = () => getRequestyConfig(registry, envConfig)

    await expect(readConfig).rejects.toThrow(`models.json does not exist`)
  })

  it('throws if JSON is invalid', async () => {
    const envConfig = await createEnvWithModelsJsonContent(tempDirectory, '{')
    const registry = createModelRegistry()

    const readConfig = () => getRequestyConfig(registry, envConfig)

    await expect(readConfig).rejects.toThrow()
  })

  it('throws if schema is invalid', async () => {
    const envConfig = await createEnvWithModelsJson(tempDirectory, { providers: [] })
    const registry = createModelRegistry()

    const readConfig = () => getRequestyConfig(registry, envConfig)

    await expect(readConfig).rejects.toThrow(`${envConfig.models_json_path} is invalid`)
  })

  it('takes apiKey from registry instead of resolving it from models.json', async () => {
    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: { [PROVIDER_ID]: { apiKey: `these-are-not-the-droids-you-are-looking-for` } },
    })
    const registry = createModelRegistry('my_api_key')

    const readConfig = await getRequestyConfig(registry, envConfig)

    expect(readConfig.provider.apiKey).toEqual('my_api_key')
  })

  it('throws if apiKey is not found in the registry', async () => {
    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: { [PROVIDER_ID]: { apiKey: 'models-json-key' } },
    })
    const registry = createModelRegistry(null)

    const readConfig = () => getRequestyConfig(registry, envConfig)

    await expect(readConfig).rejects.toThrow(`No API key found for provider ${PROVIDER_ID}`)
  })

  it('throws if configured provider is missing', async () => {
    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: { other: { apiKey: 'models-json-key' } },
    })
    const registry = createModelRegistry()

    const readConfig = () => getRequestyConfig(registry, envConfig)

    await expect(readConfig).rejects.toThrow(`${envConfig.models_json_path} does not define providers.${PROVIDER_ID}`)
  })

  it('defaults name to Requesty', async () => {
    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: { [PROVIDER_ID]: { apiKey: 'models-json-key' } },
    })
    const registry = createModelRegistry()

    const config = await getRequestyConfig(registry, envConfig)

    expect(config.provider.name).toBe('Requesty')
  })

  it('defaults base URL to https://router.requesty.ai/v1', async () => {
    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: { [PROVIDER_ID]: { apiKey: 'models-json-key' } },
    })
    const registry = createModelRegistry()

    const config = await getRequestyConfig(registry, envConfig)

    expect(config.provider.baseUrl).toBe('https://router.requesty.ai/v1')
  })

  it('removes trailing slash from base URL', async () => {
    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: {
        [PROVIDER_ID]: {
          baseUrl: 'https://router.requesty.ai/v1///',
          apiKey: 'models-json-key',
        },
      },
    })
    const registry = createModelRegistry()

    const config = await getRequestyConfig(registry, envConfig)

    expect(config.provider.baseUrl).toBe('https://router.requesty.ai/v1')
  })

  it('exposes existing model IDs of the selected provider', async () => {
    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: {
        [PROVIDER_ID]: {
          apiKey: 'models-json-key',
          models: [{ id: 'requesty/model-a' }, { id: 'requesty/model-b', name: 'Model B' }],
        },
      },
    })
    const registry = createModelRegistry()

    const config = await getRequestyConfig(registry, envConfig)

    expect(config.existingModelIds).toEqual(['requesty/model-a', 'requesty/model-b'])
  })

  it('exposes empty existing model IDs when provider has no models', async () => {
    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: { [PROVIDER_ID]: { apiKey: 'models-json-key' } },
    })
    const registry = createModelRegistry()

    const config = await getRequestyConfig(registry, envConfig)

    expect(config.existingModelIds).toEqual([])
  })
})

describe('diffModels', () => {
  it('reports no changes for identical sets', () => {
    const diff = diffModels(['a', 'b'], [createModel({ id: 'a' }), createModel({ id: 'b' })])

    expect(diff).toEqual({ added: [], removed: [] })
  })

  it('reports added and removed model IDs sorted', () => {
    const diff = diffModels(
      ['z', 'b', 'x'],
      [createModel({ id: 'b' }), createModel({ id: 'c' }), createModel({ id: 'a' })],
    )

    expect(diff).toEqual({ added: ['a', 'c'], removed: ['x', 'z'] })
  })

  it('reports everything as added when there were no previous models', () => {
    const diff = diffModels([], [createModel({ id: 'a' })])

    expect(diff).toEqual({ added: ['a'], removed: [] })
  })
})

describe('formatModelsDiffSummary', () => {
  it('reports no changes', () => {
    const summary = formatModelsDiffSummary({ added: [], removed: [] })

    expect(summary).toBe('No added models.\nNo removed models.')
  })

  it('lists added and removed models', () => {
    const summary = formatModelsDiffSummary({ added: ['a', 'b'], removed: ['z'] })

    expect(summary).toBe('Added models:\n- a\n- b\nRemoved models:\n- z')
  })

  it('reports one-sided changes', () => {
    const summary = formatModelsDiffSummary({ added: ['a'], removed: [] })

    expect(summary).toBe('Added models:\n- a\nNo removed models.')
  })
})

describe('updateModelsJson', () => {
  let tempDirectory: TempDirectory

  beforeEach(async () => {
    tempDirectory = await createTempDirectory()
  })

  afterEach(async () => {
    await tempDirectory.clean()
  })

  it('writes models into selected provider', async () => {
    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: { [PROVIDER_ID]: { apiKey: 'models-json-key', models: [] } },
    })
    const registry = createModelRegistry()
    const data = (await getRequestyConfig(registry, envConfig)).data
    const models = [createModel({ id: 'requesty/model-a', name: 'Model A' })]

    updateModelsJson(data, models, envConfig)

    const written = await readModelsJsonFile(envConfig)
    expect(written).toMatchSnapshot()
  })

  it('writes REQUESTY_API_KEY reference when selected provider has no apiKey', async () => {
    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: { [PROVIDER_ID]: { models: [] } },
    })
    const registry = createModelRegistry()
    const data = (await getRequestyConfig(registry, envConfig)).data

    updateModelsJson(data, [createModel()], envConfig)

    const written = await readModelsJsonFile(envConfig)
    expect(written.providers[PROVIDER_ID]?.apiKey).toBe('$REQUESTY_API_KEY')
  })

  it('preserves selected provider fields', async () => {
    const originalRequestyProvider = {
      name: 'Custom Requesty',
      baseUrl: 'https://example.com/v1',
      api: 'openai-completions',
      apiKey: 'models-json-key',
      customField: 'custom-value',
    }

    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: { [PROVIDER_ID]: originalRequestyProvider },
    })
    const registry = createModelRegistry()
    const data = (await getRequestyConfig(registry, envConfig)).data
    const models = [createModel(), createModel(), createModel()]

    updateModelsJson(data, models, envConfig)

    const written = await readModelsJsonFile(envConfig)
    expect(written.providers[PROVIDER_ID]).toEqual(expect.objectContaining(originalRequestyProvider))
  })

  it('preserves other providers', async () => {
    const originalAnthropicProvider = {
      name: 'Anthropic',
      apiKey: 'anthropic-key',
      models: [{ id: 'claude', name: 'Claude' }],
    }
    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: {
        [PROVIDER_ID]: { apiKey: 'models-json-key', models: [] },
        anthropic: originalAnthropicProvider,
      },
    })
    const registry = createModelRegistry()
    const data = (await getRequestyConfig(registry, envConfig)).data
    const models = [createModel()]

    updateModelsJson(data, models, envConfig)

    const written = await readModelsJsonFile(envConfig)
    expect(written.providers.anthropic).toEqual(originalAnthropicProvider)
  })

  it('creates parent directory if needed', async () => {
    const modelsJsonPath = path.join(tempDirectory.homeDir, 'nested', 'agent', 'models.json')
    const envConfig = {
      ...createTestEnv(tempDirectory),
      models_json_path: modelsJsonPath,
    }
    const data = {
      providers: { [PROVIDER_ID]: { apiKey: 'models-json-key', models: [] } },
    }
    const models = [createModel()]

    updateModelsJson(data, models, envConfig)

    const content = await fs.readFile(modelsJsonPath, 'utf8')
    expect(content).toContain('requesty/model')
  })
})

function createTestEnv(tempDirectory: TempDirectory): Env {
  return {
    models_json_path: tempDirectory.modelsJsonPath,
    health_check_log_path: tempDirectory.healthCheckLogPath,
    provider_id: DEFAULT_PROVIDER_ID,
    health_check_mode: 'full',
  }
}

async function createEnvWithModelsJsonContent(tempDirectory: TempDirectory, content: string) {
  await fs.writeFile(tempDirectory.modelsJsonPath, content, 'utf8')
  return createTestEnv(tempDirectory)
}

async function createEnvWithModelsJson(tempDirectory: TempDirectory, data: unknown) {
  return createEnvWithModelsJsonContent(tempDirectory, JSON.stringify(data))
}

async function readModelsJsonFile(envConfig: Env): Promise<TestModelsJson> {
  const content = await fs.readFile(envConfig.models_json_path, 'utf8')
  return JSON.parse(content) as TestModelsJson
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
