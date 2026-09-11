import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import type { HealthCheckResult, Provider } from './health-check'
import * as HealthCheckModule from './health-check'
import type { GetApiKey, ModelsDiff, ModelsJson } from './models-json'
import * as ModelsJsonModule from './models-json'
import * as RequestyApiModule from './requesty-api'
import { shuffleCompareFn } from '../test/helpers/shuffle'
import { type Env } from './env'
import {
  type DiscoveryEvaluation,
  type DiscoveryUi,
  evaluateDiscovery,
  finalizeDiscovery,
  getArgumentCompletions,
} from './discovery'
import { DEFAULT_PROVIDER_ID, type DiscoverySettings } from './settings'

vi.mock('./health-check')
vi.mock('./models-json')
vi.mock('./requesty-api')
vi.mock('./settings')

type HealthCheckMode = 'off' | 'basic' | 'full'

type MockScenario = {
  healthCheckMode?: HealthCheckMode
  models?: ProviderModelConfig[]
  healthResults?: HealthCheckResult[]
  getRequestyConfigError?: unknown
  discoverModelsError?: unknown
  diff?: ModelsDiff
  existingModelIds?: string[]
}

const MODELS_JSON_PATH = '/tmp/pi-requesty-home/.pi/agent/models.json'
const HEALTH_CHECK_LOG_PATH = '/tmp/pi-requesty-home/.pi/agent/requesty-health-check.log'
const SETTINGS_PATH = '/tmp/pi-requesty-home/.pi/agent/requesty-discovery-settings.json5'

const provider = {
  name: 'Requesty',
  baseUrl: 'https://router.requesty.ai/v1',
  apiKey: 'test-key',
} satisfies Provider & { name: string }

const modelsJson: ModelsJson = {
  providers: {
    [DEFAULT_PROVIDER_ID]: {
      name: 'Requesty',
      baseUrl: 'https://router.requesty.ai/v1',
      apiKey: 'test-key',
      models: [],
    },
  },
}

const getApiKey: GetApiKey = () => Promise.resolve('test-api-key')

describe('getArgumentCompletions', () => {
  it('returns dry-run option for empty prefix', () => {
    expect(getArgumentCompletions('')).toMatchSnapshot()
  })

  it('returns dry-run option for matching prefix', () => {
    expect(getArgumentCompletions('--d')).toMatchSnapshot()
  })

  it('returns empty list for unrelated prefix', () => {
    expect(getArgumentCompletions('--wat')).toEqual([])
  })
})

describe('evaluateDiscovery', () => {
  it('uses the api key resolved by the given getApiKey function', async () => {
    const { discoverModels } = configureMockedDependencies()
    const ui = createUi()

    await evaluateDiscovery('', createSettings(), createEnv(), ui, getApiKey)

    expect(discoverModels).toHaveBeenCalledWith({ ...provider, apiKey: 'test-api-key' })
  })

  it('forwards the api key resolved by the given getApiKey function to discoverModels', async () => {
    const { discoverModels } = configureMockedDependencies()
    const ui = createUi()
    const customGetApiKey: GetApiKey = () => Promise.resolve('custom-api-key')

    await evaluateDiscovery('', createSettings(), createEnv(), ui, customGetApiKey)

    expect(discoverModels).toHaveBeenCalledWith({ ...provider, apiKey: 'custom-api-key' })
  })

  it('reports progress while checking models', async () => {
    const models = [createModel({ id: 'requesty/model-a' }), createModel({ id: 'requesty/model-b' })]
    configureMockedDependencies({ models })
    const ui = createUi()

    await evaluateDiscovery('', createSettings(), createEnv(), ui, getApiKey)

    expect(ui.statuses).toEqual([
      'Discovering Requesty models...',
      'Checking models 0/2...',
      'Checking models 1/2...',
      'Checking models 2/2...',
    ])
  })

  it('marks passing models on full success', async () => {
    const models = [createModel({ id: 'requesty/model-a' }), createModel({ id: 'requesty/model-b' })]
    const healthResults = [
      createHealthCheckResult({ modelId: 'requesty/model-a', status: 'ok' }),
      createHealthCheckResult({ modelId: 'requesty/model-b', status: 'ok' }),
    ]
    configureMockedDependencies({ models, healthResults })
    const ui = createUi()

    const evaluation = await evaluateDiscovery('', createSettings(), createEnv(), ui, getApiKey)

    expect(evaluation.passing).toEqual(models)
    expect(evaluation.failedCount).toBe(0)
    expect(evaluation.modelCount).toBe(2)
  })

  it('keeps existing rate-limited models instead of removing them', async () => {
    const modelA = createModel({ id: 'requesty/model-a' })
    const rateLimitedModel = createModel({ id: 'requesty/rate-limited-model' })
    const healthResults = [
      createHealthCheckResult({ modelId: 'requesty/model-a', status: 'ok' }),
      createHealthCheckResult({
        modelId: 'requesty/rate-limited-model',
        status: 'warning',
        error: 'HTTP 429 Too Many Requests',
      }),
    ]
    configureMockedDependencies({
      models: [modelA, rateLimitedModel],
      healthResults,
      existingModelIds: ['requesty/rate-limited-model'],
    })
    const ui = createUi()

    const evaluation = await evaluateDiscovery('', createSettings(), createEnv(), ui, getApiKey)

    expect(evaluation.passing).toEqual(expect.arrayContaining([modelA, rateLimitedModel]))
    expect(evaluation.failedCount).toBe(0)
    expect(evaluation.warningCount).toBe(1)
  })

  it('adds new rate-limited models', async () => {
    const modelA = createModel({ id: 'requesty/model-a' })
    const rateLimitedModel = createModel({ id: 'requesty/rate-limited-model' })
    const healthResults = [
      createHealthCheckResult({ modelId: 'requesty/model-a', status: 'ok' }),
      createHealthCheckResult({
        modelId: 'requesty/rate-limited-model',
        status: 'warning',
        error: 'HTTP 429 Too Many Requests',
      }),
    ]
    configureMockedDependencies({
      models: [modelA, rateLimitedModel],
      healthResults,
      existingModelIds: [],
    })
    const ui = createUi()

    const evaluation = await evaluateDiscovery('', createSettings(), createEnv(), ui, getApiKey)

    expect(evaluation.passing).toEqual([modelA, rateLimitedModel])
    expect(evaluation.warningCount).toBe(1)
  })

  it('keeps only passing models on partial failures', async () => {
    const passingModel = createModel({ id: 'requesty/passing-model' })
    const failingModel = createModel({ id: 'requesty/failing-model' })
    const healthResults = [
      createHealthCheckResult({ modelId: 'requesty/passing-model', status: 'ok' }),
      createHealthCheckResult({ modelId: 'requesty/failing-model', status: 'error' }),
    ]
    configureMockedDependencies({ models: [passingModel, failingModel], healthResults })
    const ui = createUi()

    const evaluation = await evaluateDiscovery('', createSettings(), createEnv(), ui, getApiKey)

    expect(evaluation.passing).toEqual([passingModel])
    expect(evaluation.failedCount).toBe(1)
  })

  it('sorts failing models deterministically for logging', async () => {
    const failingModel1 = createModel({ id: 'requesty/failing-model-1' })
    const failingModel2 = createModel({ id: 'requesty/failing-model-2' })
    const failingModel3 = createModel({ id: 'requesty/failing-model-3' })
    const shuffledHealthResults = [
      createHealthCheckResult({ modelId: 'requesty/failing-model-1', status: 'error' }),
      createHealthCheckResult({ modelId: 'requesty/failing-model-2', status: 'error' }),
      createHealthCheckResult({ modelId: 'requesty/failing-model-3', status: 'error' }),
    ].toSorted(shuffleCompareFn)
    const { formatHealthSummary, writeHealthCheckLog } = configureMockedDependencies({
      models: [failingModel1, failingModel2, failingModel3],
      healthResults: shuffledHealthResults,
    })
    const ui = createUi()

    await evaluateDiscovery('', createSettings(), createEnv(), ui, getApiKey)

    const modelId = (healthCheck: HealthCheckResult) => healthCheck.modelId
    const [summaryHealthChecks] = formatHealthSummary.mock.calls[0]
    const summaryModelIds = summaryHealthChecks.map(modelId)
    expect(summaryModelIds).toEqual([
      'requesty/failing-model-1',
      'requesty/failing-model-2',
      'requesty/failing-model-3',
    ])
    const [, logHealthChecks] = writeHealthCheckLog.mock.calls[0]
    expect(logHealthChecks.map(modelId)).toEqual(summaryModelIds)
  })

  it('writes only found banned models into the health check log', async () => {
    const modelA = createModel({ id: 'requesty/model-a' })
    const bannedModel = createModel({ id: 'requesty/banned-model' })
    const { writeHealthCheckLog } = configureMockedDependencies({
      models: [modelA, bannedModel],
    })
    const ui = createUi()
    const settings = createSettings({ bannedModels: ['requesty/banned-model', 'requesty/stale-ban'] })

    await evaluateDiscovery('', settings, createEnv(), ui, getApiKey)

    const [, , , contextArg] = writeHealthCheckLog.mock.calls[0]
    expect(contextArg.bannedModels).toEqual(['requesty/banned-model'])
  })

  it('sorts passing models deterministically', async () => {
    const passingModel1 = createModel({ id: 'requesty/passing-model-1' })
    const passingModel2 = createModel({ id: 'requesty/passing-model-2' })
    const passingModel3 = createModel({ id: 'requesty/passing-model-3' })
    const shuffledHealthResults = [
      createHealthCheckResult({ modelId: 'requesty/passing-model-1', status: 'ok' }),
      createHealthCheckResult({ modelId: 'requesty/passing-model-2', status: 'ok' }),
      createHealthCheckResult({ modelId: 'requesty/passing-model-3', status: 'ok' }),
    ].toSorted(shuffleCompareFn)
    configureMockedDependencies({
      models: [passingModel1, passingModel2, passingModel3],
      healthResults: shuffledHealthResults,
    })
    const ui = createUi()

    const evaluation = await evaluateDiscovery('', createSettings(), createEnv(), ui, getApiKey)

    expect(evaluation.passing.map(m => m.id)).toEqual([
      'requesty/passing-model-1',
      'requesty/passing-model-2',
      'requesty/passing-model-3',
    ])
  })

  it('excludes banned models from the health check and the passing list', async () => {
    const modelA = createModel({ id: 'requesty/model-a' })
    const bannedModel = createModel({ id: 'requesty/banned-model' })
    const settings = createSettings({ bannedModels: ['requesty/banned-model'] })
    const { checkModels } = configureMockedDependencies({
      models: [modelA, bannedModel],
    })
    const ui = createUi()

    const evaluation = await evaluateDiscovery('', settings, createEnv(), ui, getApiKey)

    expect(checkModels).toHaveBeenCalledWith(expect.anything(), [modelA], expect.anything(), expect.anything())
    expect(evaluation.passing).toEqual([modelA])
    expect(evaluation.modelCount).toBe(1)
  })

  it('excludes banned models when health checks are off', async () => {
    const modelA = createModel({ id: 'requesty/model-a' })
    const bannedModel = createModel({ id: 'requesty/banned-model' })
    const settings = createSettings({ bannedModels: ['requesty/banned-model'], healthCheckMode: 'off' })
    configureMockedDependencies({
      healthCheckMode: 'off',
      models: [modelA, bannedModel],
    })
    const ui = createUi()

    const evaluation = await evaluateDiscovery('', settings, createEnv(), ui, getApiKey)

    expect(evaluation.passing).toEqual([modelA])
    expect(evaluation.modelCount).toBe(1)
  })

  it('does not call the health check when all models are banned', async () => {
    const settings = createSettings({ bannedModels: ['requesty/banned-model'] })
    const { checkModels } = configureMockedDependencies({
      models: [createModel({ id: 'requesty/banned-model' })],
    })
    const ui = createUi()

    const evaluation = await evaluateDiscovery('', settings, createEnv(), ui, getApiKey)

    expect(checkModels).not.toHaveBeenCalled()
    expect(evaluation.passing).toEqual([])
    expect(evaluation.modelCount).toBe(0)
  })

  it('includes the model diff even when health checks are off', async () => {
    const diff = { added: ['requesty/model-new'], removed: [] }
    const { diffModels } = configureMockedDependencies({ healthCheckMode: 'off', diff })
    const ui = createUi()

    const evaluation = await evaluateDiscovery(
      '',
      createSettings({ healthCheckMode: 'off' }),
      createEnv(),
      ui,
      getApiKey,
    )

    expect(diffModels).toHaveBeenCalled()
    expect(evaluation.diff).toEqual(diff)
  })

  it('propagates getRequestyConfig errors', async () => {
    configureMockedDependencies({ getRequestyConfigError: new Error('models.json exploded') })
    const ui = createUi()

    await expect(evaluateDiscovery('', createSettings(), createEnv(), ui, getApiKey)).rejects.toThrow(
      'models.json exploded',
    )
  })

  it('propagates discoverModels errors', async () => {
    configureMockedDependencies({ discoverModelsError: new Error('bad day') })
    const ui = createUi()

    await expect(evaluateDiscovery('', createSettings(), createEnv(), ui, getApiKey)).rejects.toThrow('bad day')
  })

  it('detects dry-run from args', async () => {
    configureMockedDependencies()
    const ui = createUi()

    const evaluation = await evaluateDiscovery(
      '--dry-run',
      createSettings({ healthCheckMode: 'off' }),
      createEnv(),
      ui,
      getApiKey,
    )

    expect(evaluation.dryRun).toBe(true)
  })
})

describe('finalizeDiscovery', () => {
  it('does not update models.json and only notifies on dry-run', async () => {
    const { updateModelsJson } = configureMockedDependencies()
    const ui = createUi()

    await finalizeDiscovery(createEvaluation({ dryRun: true }), createSettings(), createEnv(), ui)

    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(ui.confirmations).toEqual([])
    expect(ui.notifications[0]?.message).toContain('Dry run: left models.json unchanged.')
  })

  it('does not confirm or update when there are no passing models', async () => {
    const { updateModelsJson } = configureMockedDependencies()
    const ui = createUi()
    const refresh = createRefresh()

    await finalizeDiscovery(createEvaluation({ passing: [] }), createSettings(), createEnv(), ui, refresh)

    expect(ui.confirmations).toEqual([])
    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(ui.notifications.at(-1)?.message).toContain('Left models.json unchanged.')
  })

  it('confirms then writes when confirmed', async () => {
    const { updateModelsJson } = configureMockedDependencies()
    const ui = createUi()
    const refresh = createRefresh()
    const evaluation = createEvaluation()

    await finalizeDiscovery(evaluation, createSettings(), createEnv(), ui, refresh)

    expect(ui.confirmations).toHaveLength(1)
    expect(updateModelsJson).toHaveBeenCalledWith(
      evaluation.data,
      evaluation.passing,
      expect.any(Object),
      expect.any(Object),
    )
    expect(refresh.calls).toBe(1)
    expect(ui.notifications.at(-1)).toEqual({
      message: 'Updated models.json. New models are available in /model.',
      level: 'info',
    })
  })

  it('notifies a plain success when no refresh is given (print mode has no live registry)', async () => {
    const { updateModelsJson } = configureMockedDependencies()
    const ui = createUi()

    await finalizeDiscovery(createEvaluation(), createSettings(), createEnv(), ui)

    expect(updateModelsJson).toHaveBeenCalled()
    expect(ui.notifications.at(-1)).toEqual({ message: 'Updated models.json.', level: 'info' })
  })

  it('notifies a warning when refreshing the registry fails after a successful write', async () => {
    const { updateModelsJson } = configureMockedDependencies()
    const ui = createUi()
    const refresh = createRefresh(new Error('registry exploded'))

    await finalizeDiscovery(createEvaluation(), createSettings(), createEnv(), ui, refresh)

    expect(updateModelsJson).toHaveBeenCalled()
    expect(ui.notifications.at(-1)).toEqual({
      message:
        'Updated models.json, but the model registry could not be refreshed: registry exploded. Run /reload or restart Pi to use the changes.',
      level: 'warning',
    })
  })

  it('does not write when confirmation is declined', async () => {
    const { updateModelsJson } = configureMockedDependencies()
    const ui = createUi(false)
    const refresh = createRefresh()

    await finalizeDiscovery(createEvaluation(), createSettings(), createEnv(), ui, refresh)

    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(refresh.calls).toBe(0)
    expect(ui.notifications.at(-1)).toEqual({
      message: 'Left models.json unchanged.',
      level: 'info',
    })
  })

  it('does not refresh the registry on dry-run or no-passing-models exits', async () => {
    const { updateModelsJson } = configureMockedDependencies()
    const ui = createUi()
    const refresh = createRefresh()

    await finalizeDiscovery(createEvaluation({ dryRun: true }), createSettings(), createEnv(), ui, refresh)
    await finalizeDiscovery(createEvaluation({ passing: [] }), createSettings(), createEnv(), ui, refresh)

    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(refresh.calls).toBe(0)
  })

  it('still confirms when the model id diff is empty, asking to refresh', async () => {
    const ui = createUi()

    await finalizeDiscovery(createEvaluation({ diff: { added: [], removed: [] } }), createSettings(), createEnv(), ui)

    expect(ui.confirmations).toEqual([
      {
        title: 'Refresh models.json?',
        message: 'No model ID changes. Rewrite the file to refresh metadata anyway?',
      },
    ])
  })

  it('asks to write when the model id diff has changes', async () => {
    const ui = createUi()
    const evaluation = createEvaluation({ diff: { added: ['requesty/model-new'], removed: [] } })

    await finalizeDiscovery(evaluation, createSettings(), createEnv(), ui)

    expect(ui.confirmations).toEqual([
      {
        title: `Write ${evaluation.passing.length} model(s)?`,
        message: 'Update models.json with the discovery result above.',
      },
    ])
  })

  it('notifies info when no models failed', async () => {
    const ui = createUi()

    await finalizeDiscovery(createEvaluation({ failedCount: 0, modelCount: 2 }), createSettings(), createEnv(), ui)

    expect(ui.notifications[0]?.level).toBe('info')
  })

  it('notifies warning when only warnings occurred', async () => {
    const ui = createUi()

    await finalizeDiscovery(
      createEvaluation({ failedCount: 0, warningCount: 1, modelCount: 2 }),
      createSettings(),
      createEnv(),
      ui,
    )

    expect(ui.notifications[0]?.level).toBe('warning')
  })

  it('notifies error on any real failure', async () => {
    const ui = createUi()

    await finalizeDiscovery(createEvaluation({ failedCount: 1, modelCount: 2 }), createSettings(), createEnv(), ui)

    expect(ui.notifications[0]?.level).toBe('error')
  })

  it('notifies error when all models failed', async () => {
    const ui = createUi()

    await finalizeDiscovery(
      createEvaluation({ failedCount: 2, modelCount: 2, passing: [] }),
      createSettings(),
      createEnv(),
      ui,
    )

    expect(ui.notifications[0]?.level).toBe('error')
  })

  it('includes health check summary and log note in the summary', async () => {
    const ui = createUi()
    const evaluation = createEvaluation({
      healthCheckSummary: 'Health check summary.\n',
      logNote: `Full health check log: ${HEALTH_CHECK_LOG_PATH}\n`,
      diff: { added: ['requesty/model-a'], removed: [] },
    })

    await finalizeDiscovery(evaluation, createSettings(), createEnv(), ui)

    expect(ui.notifications[0]?.message).toEqual(
      [
        'Discovered 1 Requesty model(s).',
        'Health check summary.',
        'Models diff summary.',
        `Full health check log: ${HEALTH_CHECK_LOG_PATH}`,
      ].join('\n'),
    )
  })
})

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    models_json_path: MODELS_JSON_PATH,
    health_check_log_path: HEALTH_CHECK_LOG_PATH,
    settings_path: SETTINGS_PATH,
    ...overrides,
  }
}

function createSettings(overrides: Partial<DiscoverySettings> = {}): DiscoverySettings {
  return {
    providerId: DEFAULT_PROVIDER_ID,
    healthCheckMode: 'basic',
    bannedModels: [],
    ...overrides,
  }
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

function createHealthCheckResult(overrides: Partial<HealthCheckResult> = {}): HealthCheckResult {
  return {
    modelId: 'requesty/model',
    status: 'ok',
    latencyMs: 123,
    ...overrides,
  }
}

/** Fake DiscoveryUi that records notifications, confirmations, and status messages. */
function createUi(confirmResult = true): DiscoveryUi & {
  notifications: Array<{ message: string; level: string }>
  confirmations: Array<{ title: string; message: string }>
  statuses: string[]
} {
  const notifications: Array<{ message: string; level: string }> = []
  const confirmations: Array<{ title: string; message: string }> = []
  const statuses: string[] = []
  return {
    notifications,
    confirmations,
    statuses,
    notify(message, level) {
      notifications.push({ message, level })
    },
    confirm(title, message) {
      confirmations.push({ title, message })
      return Promise.resolve(confirmResult)
    },
    setStatus(message) {
      statuses.push(message)
    },
  }
}

/** Fake refresh callback that counts invocations and optionally rejects. */
function createRefresh(error?: Error): (() => Promise<void>) & { calls: number } {
  const refresh = (() => {
    refresh.calls++
    return error ? Promise.reject(error) : Promise.resolve()
  }) as (() => Promise<void>) & { calls: number }
  refresh.calls = 0
  return refresh
}

/** Configure mocked domain deps for evaluateDiscovery/finalizeDiscovery. */
function configureMockedDependencies(scenario: MockScenario = {}) {
  const models = scenario.models ?? [createModel({ id: 'requesty/model-a' })]
  const healthResults = scenario.healthResults ?? models.map(model => createHealthCheckResult({ modelId: model.id }))

  const getRequestyConfig = vi.mocked(ModelsJsonModule.getRequestyConfig)
  if (scenario.getRequestyConfigError) {
    getRequestyConfig.mockThrow(scenario.getRequestyConfigError)
  } else {
    getRequestyConfig.mockImplementation(async (getApiKey, settings) => {
      const apiKey = await getApiKey(settings.providerId)
      return {
        data: modelsJson,
        provider: { ...provider, apiKey: apiKey ?? 'not-found' },
        existingModelIds: scenario.existingModelIds ?? [],
      }
    })
  }

  const updateModelsJson = vi.mocked(ModelsJsonModule.updateModelsJson)
  const diffModels = vi.mocked(ModelsJsonModule.diffModels)
  diffModels.mockReturnValue(scenario.diff ?? { added: [], removed: [] })
  const formatModelsDiffSummary = vi.mocked(ModelsJsonModule.formatModelsDiffSummary)
  formatModelsDiffSummary.mockReturnValue('Models diff summary.')

  const discoverModels = vi.mocked(RequestyApiModule.discoverModels)
  if (scenario.discoverModelsError) {
    discoverModels.mockRejectedValue(scenario.discoverModelsError)
  } else {
    discoverModels.mockResolvedValue(models)
  }

  const checkModels = vi.mocked(HealthCheckModule.checkModels)
  checkModels.mockImplementation(
    async (
      _provider,
      checkedModels,
      _checkReasoning,
      healthCheckOptions,
      // part of function signature
      // eslint-disable-next-line @typescript-eslint/require-await
    ) => {
      healthResults.forEach((result, index) => {
        healthCheckOptions?.onProgress?.({
          completed: index + 1,
          total: checkedModels.length,
          modelId: result.modelId,
        })
      })
      return healthResults
    },
  )
  const formatHealthSummary = vi.mocked(HealthCheckModule.formatHealthSummary)
  formatHealthSummary.mockReturnValue('Health check summary.\n')
  const writeHealthCheckLog = vi.mocked(HealthCheckModule.writeHealthCheckLog)

  return {
    getRequestyConfig,
    updateModelsJson,
    diffModels,
    formatModelsDiffSummary,
    discoverModels,
    checkModels,
    formatHealthSummary,
    writeHealthCheckLog,
  }
}

function createEvaluation(overrides: Partial<DiscoveryEvaluation> = {}): DiscoveryEvaluation {
  return {
    dryRun: false,
    modelCount: 1,
    failedCount: 0,
    warningCount: 0,
    passing: [createModel({ id: 'requesty/model-a' })],
    diff: { added: [], removed: [] },
    healthCheckSummary: '',
    logNote: '',
    data: modelsJson,
    ...overrides,
  }
}
