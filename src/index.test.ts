import type { RegisteredCommand } from '@earendil-works/pi-coding-agent'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiKeyInfo } from './requesty-api'
import * as RequestyApiModule from './requesty-api'
import type { RequestyStatusLoader } from './ui/requesty-status-loader.ts'
import * as ModelsJsonModule from './models-json'
import * as EnvModule from './env'
import { Env } from './env'
import type { DiscoveryEvaluation, Try } from './discovery'
import * as DiscoveryModule from './discovery'
import { createFakeCommandContext, createFakePi, fireEvent } from '../test/helpers/fake-pi'
import { resetUsageStatusCache } from './index.ts'

vi.mock('./discovery', async importOriginal => {
  const actual = await importOriginal<typeof import('./discovery')>()
  return {
    ...actual,
    evaluateDiscovery: vi.fn(),
    finalizeDiscovery: vi.fn(),
  }
})
vi.mock('./models-json')
vi.mock('./requesty-api')
vi.mock('./env', async importOriginal => {
  const actual = await importOriginal<typeof import('./env')>()
  return { ...actual, getEnv: vi.fn() }
})

const COMMAND_NAME = 'requesty-discover'
const REQUESTY_PROVIDER_ID = EnvModule.DEFAULT_PROVIDER_ID

type TestCommand = Omit<RegisteredCommand, 'name' | 'sourceInfo'>

const MODELS_JSON_PATH = '/tmp/pi-requesty-home/.pi/agent/models.json'
const HEALTH_CHECK_LOG_PATH = '/tmp/pi-requesty-home/.pi/agent/requesty-health-check.log'

const provider = {
  name: 'Requesty',
  baseUrl: 'https://router.requesty.ai/v1',
  manageBaseUrl: 'https://api-v2.requesty.ai/v1/manage',
  apiKey: 'test-key',
}

describe('extension registration', () => {
  it('registers requesty sync command', async () => {
    mockEnv()

    const { command } = await loadExtension()

    expect(command.description).toBe(
      'Dynamically discover Requesty models, run health checks, and update the local models.json.',
    )
    expect(command.getArgumentCompletions).toBeTypeOf('function')
    expect(command.handler).toBeTypeOf('function')
  })

  it('registers all expected event handlers', async () => {
    mockEnv()

    const { eventHandlers } = await loadExtension()

    expect(eventHandlers.get('session_start')).toBeTypeOf('function')
    expect(eventHandlers.get('turn_end')).toBeTypeOf('function')
    expect(eventHandlers.get('model_select')).toBeTypeOf('function')
  })

  it('command handler delegates to runDiscoveryWorkflow', async () => {
    const mockedEnv = mockOkEnv()
    const evaluation = createEvaluation()
    vi.mocked(DiscoveryModule.evaluateDiscovery).mockResolvedValue(evaluation)
    vi.mocked(DiscoveryModule.finalizeDiscovery).mockResolvedValue(undefined)
    const { command } = await loadExtension()
    const { ctx } = createFakeCommandContext()

    await command.handler('--dry-run', ctx)

    expect(DiscoveryModule.evaluateDiscovery).toHaveBeenCalledWith(
      '--dry-run',
      mockedEnv.value,
      expect.any(Object),
      expect.any(Function),
    )
    expect(DiscoveryModule.finalizeDiscovery).toHaveBeenCalledWith(
      evaluation,
      mockedEnv.value,
      expect.any(Object),
      expect.any(Function),
    )
  })
})

describe('argument completions wiring', () => {
  it('delegates to discovery.getArgumentCompletions', async () => {
    mockEnv()
    const { command } = await loadExtension()

    const completions = await getArgumentCompletions(command, '--d')

    expect(completions).toEqual([expect.objectContaining({ value: '--dry-run' })])
  })
})

describe('runDiscoveryWorkflow mode dispatch', () => {
  it('wires ctx.ui (notify, confirm, status) and registry refresh into discovery in tui mode', async () => {
    const mockedEnv = mockOkEnv()
    const evaluation = createEvaluation()
    vi.mocked(DiscoveryModule.evaluateDiscovery).mockResolvedValue(evaluation)
    vi.mocked(DiscoveryModule.finalizeDiscovery).mockResolvedValue(undefined)
    const { runDiscoveryWorkflow } = await loadExtension()
    const { ctx, capturedNotifications, capturedConfirmations, capturedStatuses, capturedModelRefreshes } =
      createFakeCommandContext({
        confirmResult: true,
        knownApiKeys: { [REQUESTY_PROVIDER_ID]: 'my-api-key' },
      })

    await runDiscoveryWorkflow(ctx, mockedEnv, '')

    expect(DiscoveryModule.evaluateDiscovery).toHaveBeenCalled()
    expect(DiscoveryModule.finalizeDiscovery).toHaveBeenCalled()
    const [args, env, ui, getApiKey] = vi.mocked(DiscoveryModule.evaluateDiscovery).mock.calls[0]
    expect(args).toBe('')
    expect(env).toBe(mockedEnv.value)
    ui.notify('hello', 'warning')
    ui.setStatus('checking...')
    await expect(ui.confirm('title', 'message')).resolves.toBe(true)
    await expect(getApiKey(REQUESTY_PROVIDER_ID)).resolves.toBe('my-api-key')
    expect(capturedNotifications).toEqual([{ message: `${COMMAND_NAME}: hello`, type: 'warning' }])
    expect(capturedStatuses).toEqual(['checking...'])
    expect(capturedConfirmations).toEqual([{ title: 'title', message: 'message' }])
    const [, , , refresh] = vi.mocked(DiscoveryModule.finalizeDiscovery).mock.calls[0]
    await refresh!()
    expect(capturedModelRefreshes).toEqual([{ allowNetwork: false }])
  })

  it('wires console ui and auto-confirm into discovery outside tui mode: no ctx.ui interaction, no registry refresh', async () => {
    const mockedEnv = mockOkEnv()
    const evaluation = createEvaluation()
    vi.mocked(DiscoveryModule.evaluateDiscovery).mockResolvedValue(evaluation)
    vi.mocked(DiscoveryModule.finalizeDiscovery).mockResolvedValue(undefined)
    const { runDiscoveryWorkflow } = await loadExtension()
    const { ctx, capturedConfirmations, capturedNotifications, capturedStatuses, capturedModelRefreshes } =
      createFakeCommandContext({
        mode: 'print',
        knownApiKeys: { [REQUESTY_PROVIDER_ID]: 'my-api-key' },
      })

    await runDiscoveryWorkflow(ctx, mockedEnv, '')

    expect(DiscoveryModule.evaluateDiscovery).toHaveBeenCalled()
    expect(DiscoveryModule.finalizeDiscovery).toHaveBeenCalled()
    const [, , ui, getApiKey] = vi.mocked(DiscoveryModule.evaluateDiscovery).mock.calls[0]
    const consoleSpy = vi.spyOn(console, 'log')
    ui.notify('hello', 'warning')
    ui.setStatus('checking...')
    // this will not result in any console output
    await expect(ui.confirm('title', 'message')).resolves.toBe(true)
    await expect(getApiKey(REQUESTY_PROVIDER_ID)).resolves.toBe('my-api-key')
    const [, , , refresh] = vi.mocked(DiscoveryModule.finalizeDiscovery).mock.calls[0]
    expect(refresh).toBeUndefined()
    expect(consoleSpy).toHaveBeenNthCalledWith(1, '[warning] hello')
    expect(consoleSpy).toHaveBeenNthCalledWith(2, 'checking...')
    expect(capturedConfirmations).toEqual([])
    expect(capturedNotifications).toEqual([])
    expect(capturedStatuses).toEqual([])
    expect(capturedModelRefreshes).toEqual([])
  })

  it('does not evaluate or finalize when env failed to load (interactive)', async () => {
    const mockedEnv = mockEnv(new Error('env load failed'))
    const { runDiscoveryWorkflow } = await loadExtension()
    const { ctx, capturedNotifications } = createFakeCommandContext()

    await runDiscoveryWorkflow(ctx, mockedEnv, '')

    expect(DiscoveryModule.evaluateDiscovery).not.toHaveBeenCalled()
    expect(DiscoveryModule.finalizeDiscovery).not.toHaveBeenCalled()
    expect(capturedNotifications).toEqual([
      { message: `${COMMAND_NAME}: failed to load env: env load failed`, type: 'error' },
    ])
  })

  it('does not evaluate or finalize when env failed to load (silent)', async () => {
    const mockedEnv = mockEnv(new Error('env load failed'))
    const { runDiscoveryWorkflow } = await loadExtension()
    const { ctx } = createFakeCommandContext({ mode: 'print' })
    const consoleSpy = vi.spyOn(console, 'log')

    await runDiscoveryWorkflow(ctx, mockedEnv, '')

    expect(DiscoveryModule.evaluateDiscovery).not.toHaveBeenCalled()
    expect(DiscoveryModule.finalizeDiscovery).not.toHaveBeenCalled()
    expect(consoleSpy).toHaveBeenCalledWith('[error] failed to load env: env load failed')
  })

  it('notifies "Discovery failed" and does not finalize when evaluation rejects (interactive)', async () => {
    const mockedEnv = mockEnv()
    vi.mocked(DiscoveryModule.evaluateDiscovery).mockRejectedValue(new Error('models.json exploded'))
    const { runDiscoveryWorkflow } = await loadExtension()
    const { ctx, capturedNotifications } = createFakeCommandContext()

    await runDiscoveryWorkflow(ctx, mockedEnv, '')

    expect(DiscoveryModule.finalizeDiscovery).not.toHaveBeenCalled()
    expect(capturedNotifications).toEqual([
      { message: `${COMMAND_NAME}: Discovery failed: models.json exploded`, type: 'error' },
    ])
  })

  it('notifies "Discovery failed" and does not finalize when evaluation rejects (silent)', async () => {
    const mockedEnv = mockEnv()
    vi.mocked(DiscoveryModule.evaluateDiscovery).mockRejectedValue(new Error('bad day'))
    const { runDiscoveryWorkflow } = await loadExtension()
    const { ctx } = createFakeCommandContext({ mode: 'print' })
    const consoleSpy = vi.spyOn(console, 'log')

    await runDiscoveryWorkflow(ctx, mockedEnv, '')

    expect(DiscoveryModule.finalizeDiscovery).not.toHaveBeenCalled()
    expect(consoleSpy).toHaveBeenCalledWith('[error] Discovery failed: bad day')
  })
})

describe('tui ui adapter', () => {
  it('createTuiUi routes notify to a prefixed ctx.ui.notify', async () => {
    mockEnv()
    const { createTuiUi } = await loadExtension()
    const { ctx, capturedNotifications } = createFakeCommandContext()

    createTuiUi(ctx).notify('hello', 'info')

    expect(capturedNotifications).toEqual([{ message: `${COMMAND_NAME}: hello`, type: 'info' }])
  })

  it('createTuiUi routes confirm to ctx.ui.confirm', async () => {
    mockEnv()
    const { createTuiUi } = await loadExtension()
    const { ctx, capturedConfirmations } = createFakeCommandContext({ confirmResult: true })

    await expect(createTuiUi(ctx).confirm('title', 'message')).resolves.toBe(true)

    expect(capturedConfirmations).toEqual([{ title: 'title', message: 'message' }])
  })

  it('createTuiUi routes setStatus to the status loader', async () => {
    mockEnv()
    const { createTuiUi } = await loadExtension()
    const setMessage = vi.fn()
    const fakeLoader = { setMessage } as unknown as RequestyStatusLoader

    createTuiUi(ctxlessLoaderScope(), fakeLoader).setStatus('Discovering Requesty models...')

    expect(setMessage).toHaveBeenCalledWith('Discovering Requesty models...')
  })

  it('createTuiUi ignores setStatus when no loader is given (env-complain path has none)', async () => {
    mockEnv()
    const { createTuiUi } = await loadExtension()
    const { ctx } = createFakeCommandContext()

    expect(() => createTuiUi(ctx).setStatus('checking...')).not.toThrow()
  })

  it('refreshRegistry calls ctx.modelRegistry.refresh and resolves on success', async () => {
    mockEnv()
    const { createRefreshRegistry } = await loadExtension()
    const { ctx, capturedModelRefreshes } = createFakeCommandContext()
    const refresh = createRefreshRegistry(ctx)

    await expect(refresh()).resolves.toBeUndefined()
    expect(capturedModelRefreshes).toEqual([{ allowNetwork: false }])
  })

  it('refreshRegistry rejects on provider errors inside the refresh result', async () => {
    mockEnv()
    const { createRefreshRegistry } = await loadExtension()
    const refreshResult = {
      aborted: false,
      errors: new Map([['requesty-export', new Error('no key')]]),
    }
    const { ctx } = createFakeCommandContext({ refreshResult })
    const refresh = createRefreshRegistry(ctx)

    await expect(refresh()).rejects.toThrow('requesty-export: no key')
  })

  it('refreshRegistry rejects on an aborted refresh even without provider errors', async () => {
    mockEnv()
    const { createRefreshRegistry } = await loadExtension()
    const refreshResult = { aborted: true, errors: new Map() }
    const { ctx } = createFakeCommandContext({ refreshResult })
    const refresh = createRefreshRegistry(ctx)

    await expect(refresh()).rejects.toThrow('refresh aborted')
  })
})

describe('console ui adapter', () => {
  it('logs level-prefixed notifications and statuses', async () => {
    mockEnv()
    const { createConsoleUi } = await loadExtension()
    const consoleSpy = vi.spyOn(console, 'log')
    const ui = createConsoleUi()

    ui.notify('hello', 'warning')
    ui.setStatus('Discovering Requesty models...')

    expect(consoleSpy).toHaveBeenCalledWith('[warning] hello')
    expect(consoleSpy).toHaveBeenCalledWith('Discovering Requesty models...')
  })

  it('always confirms: print mode is non-interactive, so writes proceed unprompted', async () => {
    mockEnv()
    const { createConsoleUi } = await loadExtension()

    await expect(createConsoleUi().confirm('title', 'message')).resolves.toBe(true)
  })
})

describe('console ui used by the workflow (silent mode)', () => {
  it('console notifier and status reporter are used outside tui mode', async () => {
    const mockedEnv = mockEnv()
    vi.mocked(DiscoveryModule.evaluateDiscovery).mockImplementation(async (_args, _env, ui) => {
      ui.setStatus('Discovering Requesty models...')
      await Promise.resolve()
      return createEvaluation()
    })
    vi.mocked(DiscoveryModule.finalizeDiscovery).mockImplementation(async (_evaluation, _env, ui) => {
      const confirmed = await ui.confirm('title', 'message')
      ui.notify(`confirmed: ${confirmed}`, 'info')
    })
    const { runDiscoveryWorkflow } = await loadExtension()
    const { ctx } = createFakeCommandContext({ mode: 'print' })
    const consoleSpy = vi.spyOn(console, 'log')

    await runDiscoveryWorkflow(ctx, mockedEnv, '')

    expect(consoleSpy).toHaveBeenCalledWith('Discovering Requesty models...')
    expect(consoleSpy).toHaveBeenCalledWith('[info] confirmed: true')
  })
})

describe('formatUsageStatus', () => {
  it('formats spend and limit with percentage', async () => {
    const { formatUsageStatus } = await loadExtension()
    const info: ApiKeyInfo = { name: 'Playground', monthlySpend: 63.545944565, monthlyLimit: 150 }

    expect(formatUsageStatus(info)).toBe('Playground: $63.55/$150.00 (42%)')
  })

  it('formats unlimited when limit is 0', async () => {
    const { formatUsageStatus } = await loadExtension()
    const info: ApiKeyInfo = { name: 'Unlimited', monthlySpend: 12.34, monthlyLimit: 0 }

    expect(formatUsageStatus(info)).toBe('Unlimited: $12.34 (unlimited)')
  })

  it('rounds spend to two decimals', async () => {
    const { formatUsageStatus } = await loadExtension()
    const info: ApiKeyInfo = { name: 'Playground', monthlySpend: 1.006, monthlyLimit: 100 }

    expect(formatUsageStatus(info)).toBe('Playground: $1.01/$100.00 (1%)')
  })

  it('preserves names with spaces and special characters', async () => {
    const { formatUsageStatus } = await loadExtension()
    const info: ApiKeyInfo = { name: 'My Team "Key"!', monthlySpend: 50, monthlyLimit: 200 }

    expect(formatUsageStatus(info)).toBe('My Team "Key"!: $50.00/$200.00 (25%)')
  })

  it('shows 0% when nothing is spent', async () => {
    const { formatUsageStatus } = await loadExtension()
    const info: ApiKeyInfo = { name: 'Playground', monthlySpend: 0, monthlyLimit: 150 }

    expect(formatUsageStatus(info)).toBe('Playground: $0.00/$150.00 (0%)')
  })
})

describe('usage status', () => {
  const events = ['session_start', 'turn_end', 'model_select']

  beforeEach(() => {
    resetUsageStatusCache()
  })

  function mockUsageDependencies(fetchApiUsageResults?: Promise<ApiKeyInfo>[]) {
    const getRequestyConfig = vi.mocked(ModelsJsonModule.getRequestyConfig)
    getRequestyConfig.mockResolvedValue({
      data: { providers: {} },
      provider,
      existingModelIds: [],
    })
    const fetchApiUsage = vi.mocked(RequestyApiModule.fetchApiUsage)
    fetchApiUsage.mockReset()
    if (fetchApiUsageResults) {
      for (const result of fetchApiUsageResults) {
        fetchApiUsage.mockReturnValueOnce(result)
      }
    } else {
      fetchApiUsage.mockResolvedValue({ name: 'Playground', monthlySpend: 0, monthlyLimit: 0 })
    }
    return { fetchApiUsage }
  }

  describe('sets the usage status line', () => {
    it.each(events)('on %s', async eventName => {
      mockEnv()
      const apiKeyInfo: ApiKeyInfo = { name: 'Playground', monthlySpend: 63.55, monthlyLimit: 150 }
      mockUsageDependencies([Promise.resolve(apiKeyInfo)])
      const { eventHandlers, USAGE_STATUS_KEY } = await loadExtension()
      const { ctx, capturedStatusLines, waitForStatusLines } = createFakeCommandContext()

      await fireEvent(eventHandlers, eventName, ctx)
      await waitForStatusLines(1)

      expect(capturedStatusLines).toEqual([{ key: USAGE_STATUS_KEY, text: containing('Playground:') }])
    })
  })

  describe('clears status when a non-Requesty provider is selected', () => {
    it.each(events)('on %s', async eventName => {
      mockEnv()
      const { fetchApiUsage } = mockUsageDependencies()
      const { eventHandlers, USAGE_STATUS_KEY } = await loadExtension()
      const { ctx, capturedStatusLines } = createFakeCommandContext({ modelProvider: 'anthropic' })

      await fireEvent(eventHandlers, eventName, ctx)

      expect(capturedStatusLines).toEqual([{ key: USAGE_STATUS_KEY, text: undefined }])
      expect(fetchApiUsage).not.toHaveBeenCalled()
    })
  })

  describe('edge cases', () => {
    it('suppresses a stale success after a newer turn already wrote', async () => {
      mockEnv()
      const firstInfo: ApiKeyInfo = { name: 'Slow', monthlySpend: 10, monthlyLimit: 100 }
      const secondInfo: ApiKeyInfo = { name: 'Fast', monthlySpend: 90, monthlyLimit: 100 }
      const first = createDeferred<ApiKeyInfo>()
      const second = createDeferred<ApiKeyInfo>()
      mockUsageDependencies([first.promise, second.promise])
      const { eventHandlers, USAGE_STATUS_KEY } = await loadExtension()
      const { ctx, capturedStatusLines, waitForStatusLines } = createFakeCommandContext()

      await fireEvent(eventHandlers, 'turn_end', ctx) // first turn starts, fetch hangs on `first`
      await fireEvent(eventHandlers, 'turn_end', ctx) // second turn starts, fetch hangs on `second`
      second.resolve(secondInfo) // newer resolves first
      await waitForStatusLines(1)
      first.resolve(firstInfo) // older resolves after, must be suppressed
      await flushMicrotasks()

      const expected = [{ key: USAGE_STATUS_KEY, text: containing('Fast:') }]
      expect(capturedStatusLines).toEqual(expected)
    })

    it('de-dupes usage fetch via the requesty API within 2 seconds', async () => {
      mockEnv()
      const firstInfo: ApiKeyInfo = { name: 'First', monthlySpend: 10, monthlyLimit: 100 }
      const secondInfo: ApiKeyInfo = { name: 'Second', monthlySpend: 90, monthlyLimit: 100 }
      mockUsageDependencies([Promise.resolve(firstInfo), Promise.resolve(secondInfo)])
      const { eventHandlers, USAGE_STATUS_KEY } = await loadExtension()
      const { ctx, capturedStatusLines, waitForStatusLines } = createFakeCommandContext()

      await fireEvent(eventHandlers, 'turn_end', ctx)
      await waitForStatusLines(1)
      await fireEvent(eventHandlers, 'turn_end', ctx)
      await flushMicrotasks()

      const expected = { key: USAGE_STATUS_KEY, text: containing('First:') }
      expect(capturedStatusLines.at(-1)).toEqual(expected)
    })

    it('re-fetches usage from the requesty API after 2 seconds', async () => {
      mockEnv()
      const timers = vi.useFakeTimers()
      const firstInfo: ApiKeyInfo = { name: 'First', monthlySpend: 10, monthlyLimit: 100 }
      const secondInfo: ApiKeyInfo = { name: 'Second', monthlySpend: 90, monthlyLimit: 100 }
      mockUsageDependencies([Promise.resolve(firstInfo), Promise.resolve(secondInfo)])
      const { eventHandlers, USAGE_STATUS_KEY } = await loadExtension()
      const { ctx, capturedStatusLines, waitForStatusLines } = createFakeCommandContext()

      await fireEvent(eventHandlers, 'turn_end', ctx)
      await waitForStatusLines(1)
      timers.advanceTimersByTime(2000)
      await fireEvent(eventHandlers, 'turn_end', ctx)
      await waitForStatusLines(2)

      const expected = { key: USAGE_STATUS_KEY, text: containing('Second:') }
      expect(capturedStatusLines.at(-1)).toEqual(expected)
    })

    it('suppresses a stale error after a newer turn already wrote', async () => {
      mockEnv()
      const secondInfo: ApiKeyInfo = { name: 'Fast', monthlySpend: 90, monthlyLimit: 100 }
      const first = createDeferred<ApiKeyInfo>()
      const second = createDeferred<ApiKeyInfo>()
      mockUsageDependencies([first.promise, second.promise])
      const { eventHandlers, USAGE_STATUS_KEY } = await loadExtension()
      const { ctx, capturedStatusLines, waitForStatusLines } = createFakeCommandContext()

      await fireEvent(eventHandlers, 'turn_end', ctx)
      await fireEvent(eventHandlers, 'turn_end', ctx)
      second.resolve(secondInfo)
      await waitForStatusLines(1)
      first.reject(new Error('HTTP 500 boom'))
      await flushMicrotasks()

      const expected = [{ key: USAGE_STATUS_KEY, text: containing('Fast:') }]
      expect(capturedStatusLines).toEqual(expected)
    })

    it('skips the fetch and writes nothing when there is no UI (print/json mode)', async () => {
      mockEnv()
      const { fetchApiUsage } = mockUsageDependencies()
      const { eventHandlers } = await loadExtension()
      const { ctx, capturedStatusLines } = createFakeCommandContext({ hasUI: false })

      await fireEvent(eventHandlers, 'turn_end', ctx)

      expect(capturedStatusLines).toEqual([])
      expect(fetchApiUsage).not.toHaveBeenCalled()
    })

    it('shows env load errors on session_start', async () => {
      mockEnv(new Error('I am error'))
      const { fetchApiUsage } = mockUsageDependencies()
      const { eventHandlers } = await loadExtension()
      const { ctx, capturedNotifications } = createFakeCommandContext()

      await fireEvent(eventHandlers, 'session_start', ctx)

      expect(capturedNotifications).toEqual([
        { message: `${COMMAND_NAME}: failed to load env: I am error`, type: 'error' },
      ])
      expect(fetchApiUsage).not.toHaveBeenCalled()
    })
  })
})

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function containing(substr: string): string {
  return expect.stringContaining(substr) as string
}

/** Drain pending microtasks so detached (fire-and-forget) async chains can settle. */
async function flushMicrotasks(rounds = 100): Promise<void> {
  for (let drained = 0; drained < rounds; drained++) {
    await Promise.resolve()
  }
}

/** The loader test needs no real ctx; notify/confirm on it would fail the capture assertions. */
function ctxlessLoaderScope(): Parameters<typeof import('./index').createTuiUi>[0] {
  return {} as Parameters<typeof import('./index').createTuiUi>[0]
}

/** Mini Pi glue: import extension, register command + event handlers, return entrypoints. */
async function loadExtension() {
  const extension = await import('./index')
  const { pi, commands, eventHandlers } = createFakePi()
  extension.default(pi)
  const command = commands.get(COMMAND_NAME)

  if (!command) {
    throw new Error(`${COMMAND_NAME} was not registered`)
  }

  return {
    command,
    runDiscoveryWorkflow: extension.runDiscoveryWorkflow,
    formatUsageStatus: extension.formatUsageStatus,
    USAGE_STATUS_KEY: extension.USAGE_STATUS_KEY,
    createTuiUi: extension.createTuiUi,
    createConsoleUi: extension.createConsoleUi,
    createRefreshRegistry: extension.createRefreshRegistry,
    eventHandlers,
  }
}

async function getArgumentCompletions(command: TestCommand, prefix: string) {
  if (!command.getArgumentCompletions) {
    throw new Error('Command did not register argument completions')
  }

  return command.getArgumentCompletions(prefix)
}

function createEvaluation(overrides: Partial<DiscoveryEvaluation> = {}): DiscoveryEvaluation {
  return {
    dryRun: false,
    modelCount: 1,
    failedCount: 0,
    passing: [],
    diff: { added: [], removed: [] },
    healthCheckSummary: '',
    logNote: '',
    data: { providers: {} },
    ...overrides,
  }
}

function mockEnv(getEnvError?: unknown): Try<Env> {
  const mockedEnv: Env = {
    models_json_path: MODELS_JSON_PATH,
    health_check_log_path: HEALTH_CHECK_LOG_PATH,
    provider_id: REQUESTY_PROVIDER_ID,
    requesty_base_url: provider.baseUrl,
    requesty_manage_base_url: provider.manageBaseUrl,
    health_check_mode: 'basic',
  }
  const getEnv = vi.mocked(EnvModule.getEnv)
  if (getEnvError) {
    getEnv.mockThrow(getEnvError)
    return { ok: false, error: getEnvError }
  }
  getEnv.mockReturnValue(mockedEnv)
  return { ok: true, value: mockedEnv }
}

function mockOkEnv(): { ok: true; value: Env } {
  const result = mockEnv()
  if (!result.ok) throw new Error('expected mockEnv() to succeed')
  return result
}
