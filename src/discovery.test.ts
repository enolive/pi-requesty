import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import type { HealthCheckResult, Provider } from './health-check'
import * as HealthCheckModule from './health-check'
import * as ModelsJsonModule from './models-json'
import type { ApiKeyProvider, ModelsDiff, ModelsJson } from './models-json'
import * as RequestyApiModule from './requesty-api'
import { shuffleCompareFn } from '../test/helpers/shuffle.ts'
import { type Env, DEFAULT_PROVIDER_ID } from './env'
import {
  complainOnBrokenEnv,
  evaluateDiscovery,
  finalizeDiscovery,
  formatDiscoveryFailure,
  getArgumentCompletions,
  runCatching,
  runCatchingAsync,
  type Confirmer,
  type DiscoveryEvaluation,
  type Notifier,
  type StatusReporter,
} from './discovery'

vi.mock('./health-check')
vi.mock('./models-json')
vi.mock('./requesty-api')

type HealthCheckMode = 'off' | 'basic' | 'full'

type MockScenario = {
  healthCheckMode?: HealthCheckMode
  models?: ProviderModelConfig[]
  healthResults?: HealthCheckResult[]
  getRequestyConfigError?: unknown
  discoverModelsError?: unknown
  diff?: ModelsDiff
}

const MODELS_JSON_PATH = '/tmp/pi-requesty-home/.pi/agent/models.json'
const HEALTH_CHECK_LOG_PATH = '/tmp/pi-requesty-home/.pi/agent/requesty-health-check.log'

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

const apiKeyProvider: ApiKeyProvider = {
  getApiKey: () => Promise.resolve('test-api-key'),
}

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

describe('runCatching', () => {
  it('wraps a successful call', () => {
    expect(runCatching(() => 42)).toEqual({ ok: true, value: 42 })
  })

  it('wraps a throwing call', () => {
    const error = new Error('boom')
    expect(
      runCatching(() => {
        throw error
      }),
    ).toEqual({ ok: false, error })
  })
})

describe('runCatchingAsync', () => {
  it('wraps a resolved promise', async () => {
    await expect(runCatchingAsync(() => Promise.resolve(42))).resolves.toEqual({ ok: true, value: 42 })
  })

  it('wraps a rejected promise', async () => {
    const error = new Error('boom')
    await expect(runCatchingAsync(() => Promise.reject(error))).resolves.toEqual({ ok: false, error })
  })
})

describe('formatDiscoveryFailure', () => {
  it('formats Error instances', () => {
    expect(formatDiscoveryFailure(new Error('models.json exploded'))).toBe('Discovery failed: models.json exploded')
  })

  it('formats non-Error throws', () => {
    expect(formatDiscoveryFailure('this is not an error')).toBe('Discovery failed: this is not an error')
  })
})

describe('complainOnBrokenEnv', () => {
  it('notifies when env failed to load', () => {
    const notifier = createNotifier()

    complainOnBrokenEnv(notifier, { ok: false, error: new Error('env load failed') })

    expect(notifier.notifications).toEqual([{ message: 'failed to load env: env load failed', level: 'error' }])
  })

  it('does nothing when env loaded fine', () => {
    const notifier = createNotifier()

    complainOnBrokenEnv(notifier, { ok: true, value: createEnv() })

    expect(notifier.notifications).toEqual([])
  })
})

describe('evaluateDiscovery', () => {
  it('uses the api key from the given provider', async () => {
    const { discoverModels } = configureMockedDependencies()
    const status = createStatusReporter()

    await evaluateDiscovery('', createEnv(), status, apiKeyProvider)

    expect(discoverModels).toHaveBeenCalledWith({ ...provider, apiKey: 'test-api-key' })
  })

  it('forwards the api key resolved by the given apiKeyProvider to discoverModels', async () => {
    const { discoverModels } = configureMockedDependencies()
    const status = createStatusReporter()
    const customApiKeyProvider: ApiKeyProvider = {
      getApiKey: () => Promise.resolve('custom-api-key'),
    }

    await evaluateDiscovery('', createEnv(), status, customApiKeyProvider)

    expect(discoverModels).toHaveBeenCalledWith({ ...provider, apiKey: 'custom-api-key' })
  })

  it('reports progress while checking models', async () => {
    const models = [createModel({ id: 'requesty/model-a' }), createModel({ id: 'requesty/model-b' })]
    configureMockedDependencies({ models })
    const status = createStatusReporter()

    await evaluateDiscovery('', createEnv(), status, apiKeyProvider)

    expect(status.messages).toEqual([
      'Discovering Requesty models...',
      'Checking models 0/2...',
      'Checking models 1/2...',
      'Checking models 2/2...',
    ])
  })

  it('marks passing models on full success', async () => {
    const models = [createModel({ id: 'requesty/model-a' }), createModel({ id: 'requesty/model-b' })]
    const healthResults = [
      createHealthCheckResult({ modelId: 'requesty/model-a', ok: true }),
      createHealthCheckResult({ modelId: 'requesty/model-b', ok: true }),
    ]
    configureMockedDependencies({ models, healthResults })
    const status = createStatusReporter()

    const evaluation = await evaluateDiscovery('', createEnv(), status, apiKeyProvider)

    expect(evaluation.passing).toEqual(models)
    expect(evaluation.failedCount).toBe(0)
    expect(evaluation.modelCount).toBe(2)
  })

  it('keeps only passing models on partial failures', async () => {
    const passingModel = createModel({ id: 'requesty/passing-model' })
    const failingModel = createModel({ id: 'requesty/failing-model' })
    const healthResults = [
      createHealthCheckResult({ modelId: 'requesty/passing-model', ok: true }),
      createHealthCheckResult({ modelId: 'requesty/failing-model', ok: false }),
    ]
    configureMockedDependencies({ models: [passingModel, failingModel], healthResults })
    const status = createStatusReporter()

    const evaluation = await evaluateDiscovery('', createEnv(), status, apiKeyProvider)

    expect(evaluation.passing).toEqual([passingModel])
    expect(evaluation.failedCount).toBe(1)
  })

  it('sorts failing models deterministically for logging', async () => {
    const failingModel1 = createModel({ id: 'requesty/failing-model-1' })
    const failingModel2 = createModel({ id: 'requesty/failing-model-2' })
    const failingModel3 = createModel({ id: 'requesty/failing-model-3' })
    const shuffledHealthResults = [
      createHealthCheckResult({ modelId: 'requesty/failing-model-1', ok: false }),
      createHealthCheckResult({ modelId: 'requesty/failing-model-2', ok: false }),
      createHealthCheckResult({ modelId: 'requesty/failing-model-3', ok: false }),
    ].toSorted(shuffleCompareFn)
    const { formatHealthSummary, writeHealthCheckLog } = configureMockedDependencies({
      models: [failingModel1, failingModel2, failingModel3],
      healthResults: shuffledHealthResults,
    })
    const status = createStatusReporter()

    await evaluateDiscovery('', createEnv(), status, apiKeyProvider)

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

  it('sorts passing models deterministically', async () => {
    const passingModel1 = createModel({ id: 'requesty/passing-model-1' })
    const passingModel2 = createModel({ id: 'requesty/passing-model-2' })
    const passingModel3 = createModel({ id: 'requesty/passing-model-3' })
    const shuffledHealthResults = [
      createHealthCheckResult({ modelId: 'requesty/passing-model-1', ok: true }),
      createHealthCheckResult({ modelId: 'requesty/passing-model-2', ok: true }),
      createHealthCheckResult({ modelId: 'requesty/passing-model-3', ok: true }),
    ].toSorted(shuffleCompareFn)
    configureMockedDependencies({
      models: [passingModel1, passingModel2, passingModel3],
      healthResults: shuffledHealthResults,
    })
    const status = createStatusReporter()

    const evaluation = await evaluateDiscovery('', createEnv(), status, apiKeyProvider)

    expect(evaluation.passing.map(m => m.id)).toEqual([
      'requesty/passing-model-1',
      'requesty/passing-model-2',
      'requesty/passing-model-3',
    ])
  })

  it('includes the model diff even when health checks are off', async () => {
    const diff = { added: ['requesty/model-new'], removed: [] }
    const { diffModels } = configureMockedDependencies({ healthCheckMode: 'off', diff })
    const status = createStatusReporter()

    const evaluation = await evaluateDiscovery('', createEnv({ health_check_mode: 'off' }), status, apiKeyProvider)

    expect(diffModels).toHaveBeenCalled()
    expect(evaluation.diff).toEqual(diff)
  })

  it('propagates getRequestyConfig errors', async () => {
    configureMockedDependencies({ getRequestyConfigError: new Error('models.json exploded') })
    const status = createStatusReporter()

    await expect(evaluateDiscovery('', createEnv(), status, apiKeyProvider)).rejects.toThrow('models.json exploded')
  })

  it('propagates discoverModels errors', async () => {
    configureMockedDependencies({ discoverModelsError: new Error('bad day') })
    const status = createStatusReporter()

    await expect(evaluateDiscovery('', createEnv(), status, apiKeyProvider)).rejects.toThrow('bad day')
  })

  it('detects dry-run from args', async () => {
    configureMockedDependencies()
    const status = createStatusReporter()

    const evaluation = await evaluateDiscovery(
      '--dry-run',
      createEnv({ health_check_mode: 'off' }),
      status,
      apiKeyProvider,
    )

    expect(evaluation.dryRun).toBe(true)
  })
})

describe('finalizeDiscovery', () => {
  it('does not update models.json and only notifies on dry-run', async () => {
    const { updateModelsJson } = configureMockedDependencies()
    const notifier = createNotifier()
    const confirmer = createConfirmer(true)

    await finalizeDiscovery(createEvaluation({ dryRun: true }), confirmer, notifier, createEnv())

    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(confirmer.confirmations).toEqual([])
    expect(notifier.notifications[0]?.message).toContain('Dry run: left models.json unchanged.')
  })

  it('does not confirm or update when there are no passing models', async () => {
    const { updateModelsJson } = configureMockedDependencies()
    const notifier = createNotifier()
    const confirmer = createConfirmer(true)

    await finalizeDiscovery(createEvaluation({ passing: [] }), confirmer, notifier, createEnv())

    expect(confirmer.confirmations).toEqual([])
    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(notifier.notifications.at(-1)?.message).toContain('Left models.json unchanged.')
  })

  it('confirms then writes when confirmed', async () => {
    const { updateModelsJson } = configureMockedDependencies()
    const notifier = createNotifier()
    const confirmer = createConfirmer(true)
    const evaluation = createEvaluation()

    await finalizeDiscovery(evaluation, confirmer, notifier, createEnv())

    expect(confirmer.confirmations).toHaveLength(1)
    expect(updateModelsJson).toHaveBeenCalledWith(evaluation.data, evaluation.passing, expect.any(Object))
    expect(notifier.notifications.at(-1)).toEqual({
      message: 'Updated models.json. Run /reload to use the changes.',
      level: 'info',
    })
  })

  it('does not write when confirmation is declined', async () => {
    const { updateModelsJson } = configureMockedDependencies()
    const notifier = createNotifier()
    const confirmer = createConfirmer(false)

    await finalizeDiscovery(createEvaluation(), confirmer, notifier, createEnv())

    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(notifier.notifications.at(-1)).toEqual({
      message: 'Left models.json unchanged.',
      level: 'info',
    })
  })

  it('still confirms when the model id diff is empty, asking to refresh', async () => {
    const notifier = createNotifier()
    const confirmer = createConfirmer(true)

    await finalizeDiscovery(createEvaluation({ diff: { added: [], removed: [] } }), confirmer, notifier, createEnv())

    expect(confirmer.confirmations).toEqual([
      {
        title: 'Refresh models.json?',
        message: 'No model ID changes. Rewrite the file to refresh metadata anyway?',
      },
    ])
  })

  it('asks to write when the model id diff has changes', async () => {
    const notifier = createNotifier()
    const confirmer = createConfirmer(true)
    const evaluation = createEvaluation({ diff: { added: ['requesty/model-new'], removed: [] } })

    await finalizeDiscovery(evaluation, confirmer, notifier, createEnv())

    expect(confirmer.confirmations).toEqual([
      {
        title: `Write ${evaluation.passing.length} model(s)?`,
        message: 'Update models.json with the discovery result above.',
      },
    ])
  })

  it('notifies info when no models failed', async () => {
    const notifier = createNotifier()
    const confirmer = createConfirmer(true)

    await finalizeDiscovery(createEvaluation({ failedCount: 0, modelCount: 2 }), confirmer, notifier, createEnv())

    expect(notifier.notifications[0]?.level).toBe('info')
  })

  it('notifies warning on partial failures', async () => {
    const notifier = createNotifier()
    const confirmer = createConfirmer(true)

    await finalizeDiscovery(createEvaluation({ failedCount: 1, modelCount: 2 }), confirmer, notifier, createEnv())

    expect(notifier.notifications[0]?.level).toBe('warning')
  })

  it('notifies error when all models failed', async () => {
    const notifier = createNotifier()
    const confirmer = createConfirmer(true)

    await finalizeDiscovery(
      createEvaluation({ failedCount: 2, modelCount: 2, passing: [] }),
      confirmer,
      notifier,
      createEnv(),
    )

    expect(notifier.notifications[0]?.level).toBe('error')
  })

  it('includes health check summary and log note in the summary', async () => {
    const notifier = createNotifier()
    const confirmer = createConfirmer(true)
    const evaluation = createEvaluation({
      healthCheckSummary: 'Health check summary.\n',
      logNote: `Full health check log: ${HEALTH_CHECK_LOG_PATH}\n`,
      diff: { added: ['requesty/model-a'], removed: [] },
    })

    await finalizeDiscovery(evaluation, confirmer, notifier, createEnv())

    expect(notifier.notifications[0]?.message).toEqual(
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
    provider_id: DEFAULT_PROVIDER_ID,
    health_check_mode: 'basic',
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
    ok: true,
    latencyMs: 123,
    ...overrides,
  }
}

function createStatusReporter(): StatusReporter & { messages: string[] } {
  const messages: string[] = []
  return {
    messages,
    set(message: string) {
      messages.push(message)
    },
  }
}

function createNotifier(): Notifier & { notifications: Array<{ message: string; level: string }> } {
  const notifications: Array<{ message: string; level: string }> = []
  return {
    notifications,
    notify(message, level) {
      notifications.push({ message, level })
    },
  }
}

function createConfirmer(result: boolean): Confirmer & { confirmations: Array<{ title: string; message: string }> } {
  const confirmations: Array<{ title: string; message: string }> = []
  return {
    confirmations,
    confirm(title, message) {
      confirmations.push({ title, message })
      return Promise.resolve(result)
    },
  }
}

/** Configure mocked domain deps for evaluateDiscovery/finalizeDiscovery. */
function configureMockedDependencies(scenario: MockScenario = {}) {
  const models = scenario.models ?? [createModel({ id: 'requesty/model-a' })]
  const healthResults = scenario.healthResults ?? models.map(model => createHealthCheckResult({ modelId: model.id }))

  const getRequestyConfig = vi.mocked(ModelsJsonModule.getRequestyConfig)
  if (scenario.getRequestyConfigError) {
    getRequestyConfig.mockThrow(scenario.getRequestyConfigError)
  } else {
    getRequestyConfig.mockImplementation(async (givenApiKeyProvider, env = createEnv()) => {
      const apiKey = await givenApiKeyProvider.getApiKey(env.provider_id)
      return {
        data: modelsJson,
        provider: { ...provider, apiKey: apiKey ?? 'not-found' },
        existingModelIds: [],
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
    passing: [createModel({ id: 'requesty/model-a' })],
    diff: { added: [], removed: [] },
    healthCheckSummary: '',
    logNote: '',
    data: modelsJson,
    ...overrides,
  }
}
