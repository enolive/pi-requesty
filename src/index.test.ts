import type { RegisteredCommand } from '@earendil-works/pi-coding-agent'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiKeyInfo } from './requesty-api'
import * as RequestyApiModule from './requesty-api'
import type { RequestyStatusLoader } from './ui/requesty-status-loader.ts'
import * as ModelsJsonModule from './models-json'
import * as EnvModule from './env'
import type { Env } from './env'
import * as SettingsModule from './settings'
import { DEFAULT_PROVIDER_ID, type DiscoverySettings } from './settings'
import type { DiscoveryEvaluation } from './discovery'
import * as DiscoveryModule from './discovery'
import { createFakeCommandContext, createFakePi, fireEvent } from '../test/helpers/fake-pi'
import { resetUsageStatusCache, USAGE_STATUS_KEY } from './index'

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
vi.mock('./env')
vi.mock('./settings')

const COMMAND_NAME = 'requesty-discover'
const REQUESTY_PROVIDER_ID = DEFAULT_PROVIDER_ID

type TestCommand = Omit<RegisteredCommand, 'name' | 'sourceInfo'>

const MODELS_JSON_PATH = '/tmp/pi-requesty-home/.pi/agent/models.json'
const HEALTH_CHECK_LOG_PATH = '/tmp/pi-requesty-home/.pi/agent/requesty-health-check.log'
const SETTINGS_PATH = '/tmp/pi-requesty-home/.pi/agent/requesty-discovery-settings.json5'

const provider = {
  name: 'Requesty',
  baseUrl: 'https://router.requesty.ai/v1',
  apiKey: 'test-key',
}

describe('extension registration', () => {
  it('registers requesty sync command', async () => {
    const { command } = await loadExtension()

    expect(command.description).toBe(
      'Dynamically discover Requesty models, run health checks, and update the local models.json.',
    )
    expect(command.getArgumentCompletions).toBeTypeOf('function')
    expect(command.handler).toBeTypeOf('function')
  })

  it('registers all expected event handlers', async () => {
    const { eventHandlers } = await loadExtension()

    expect(eventHandlers.get('session_start')).toBeTypeOf('function')
    expect(eventHandlers.get('turn_end')).toBeTypeOf('function')
    expect(eventHandlers.get('model_select')).toBeTypeOf('function')
  })

  it('registers nothing when env loading fails', async () => {
    vi.mocked(EnvModule.getEnv).mockThrow(new Error('env exploded'))

    const act = () => loadExtension()

    await expect(act).rejects.toThrow(`${COMMAND_NAME} was not registered`)
  })

  it('registers nothing when settings loading fails', async () => {
    vi.mocked(EnvModule.getEnv).mockReturnValue(createTestEnv())
    vi.mocked(SettingsModule.readDiscoverySettings).mockThrow(new Error('settings exploded'))

    const act = () => loadExtension()

    await expect(act).rejects.toThrow(`${COMMAND_NAME} was not registered`)
  })

  it('command handler delegates to runDiscoveryWorkflow', async () => {
    const mockedEnv = createTestEnv()
    const mockedSettings = createTestSettings()
    vi.mocked(EnvModule.getEnv).mockReturnValue(mockedEnv)
    vi.mocked(SettingsModule.readDiscoverySettings).mockReturnValue(mockedSettings)
    const evaluation = createEvaluation()
    vi.mocked(DiscoveryModule.evaluateDiscovery).mockResolvedValue(evaluation)
    vi.mocked(DiscoveryModule.finalizeDiscovery).mockResolvedValue(undefined)
    const { command } = await loadExtension()
    const { ctx } = createFakeCommandContext()

    await command.handler('--dry-run', ctx)

    expect(DiscoveryModule.evaluateDiscovery).toHaveBeenCalledWith(
      '--dry-run',
      mockedSettings,
      mockedEnv,
      expect.any(Object),
      expect.any(Function),
    )
    expect(DiscoveryModule.finalizeDiscovery).toHaveBeenCalledWith(
      evaluation,
      mockedSettings,
      mockedEnv,
      expect.any(Object),
      expect.any(Function),
    )
  })
})

describe('argument completions wiring', () => {
  it('delegates to discovery.getArgumentCompletions', async () => {
    const { command } = await loadExtension()

    const completions = await getArgumentCompletions(command, '--d')

    expect(completions).toEqual([expect.objectContaining({ value: '--dry-run' })])
  })
})

describe('runDiscoveryWorkflow (tui mode)', () => {
  it('passes args, settings, env and a loader-backed ui to evaluateDiscovery', async () => {
    const env = createTestEnv()
    const settings = createTestSettings()
    const evaluation = createEvaluation()
    vi.mocked(DiscoveryModule.evaluateDiscovery).mockResolvedValue(evaluation)
    vi.mocked(DiscoveryModule.finalizeDiscovery).mockResolvedValue(undefined)
    const { runDiscoveryWorkflow } = await loadExtension()
    const { ctx, capturedStatuses } = createFakeCommandContext({
      knownApiKeys: { [REQUESTY_PROVIDER_ID]: 'my-api-key' },
    })

    await runDiscoveryWorkflow(ctx, settings, env, '--dry-run')

    const [args, evaluateSettings, evaluateEnv, evaluateUi, getApiKey] = vi.mocked(DiscoveryModule.evaluateDiscovery)
      .mock.calls[0]
    expect(args).toBe('--dry-run')
    expect(evaluateSettings).toBe(settings)
    expect(evaluateEnv).toBe(env)
    // loader-backed ui: statuses reach the loader, notifications reach ctx.ui
    evaluateUi.setStatus('checking...')
    expect(capturedStatuses).toEqual(['checking...'])
    await expect(getApiKey(REQUESTY_PROVIDER_ID)).resolves.toBe('my-api-key')
  })

  it('passes the evaluation, settings, env and a refresh registry to finalizeDiscovery with a no-loader ui', async () => {
    const env = createTestEnv()
    const settings = createTestSettings()
    const evaluation = createEvaluation()
    vi.mocked(DiscoveryModule.evaluateDiscovery).mockResolvedValue(evaluation)
    vi.mocked(DiscoveryModule.finalizeDiscovery).mockResolvedValue(undefined)
    const { runDiscoveryWorkflow } = await loadExtension()
    const { ctx, capturedStatuses, capturedModelRefreshes } = createFakeCommandContext({
      confirmResult: true,
      knownApiKeys: { [REQUESTY_PROVIDER_ID]: 'my-api-key' },
    })

    await runDiscoveryWorkflow(ctx, settings, env, '')

    const [finalizeEvaluation, finalizeSettings, finalizeEnv, finalizeUi, refresh] = vi.mocked(
      DiscoveryModule.finalizeDiscovery,
    ).mock.calls[0]
    expect(finalizeEvaluation).toBe(evaluation)
    expect(finalizeSettings).toBe(settings)
    expect(finalizeEnv).toBe(env)
    // no status loader is set for finalization: setStatus is a no-op by composition
    finalizeUi.setStatus('finalizing...')
    expect(capturedStatuses).toEqual([])
    // refresh is wired to the model registry
    await refresh!()
    expect(capturedModelRefreshes).toEqual([{ allowNetwork: false }])
  })

  it('updates the usage status after the discovery in ui mode', async () => {
    const env = createTestEnv()
    const settings = createTestSettings()
    const evaluation = createEvaluation()
    vi.mocked(DiscoveryModule.evaluateDiscovery).mockResolvedValue(evaluation)
    vi.mocked(DiscoveryModule.finalizeDiscovery).mockResolvedValue(undefined)
    const { runDiscoveryWorkflow } = await loadExtension()
    const { ctx, capturedStatusLines } = createFakeCommandContext({
      confirmResult: true,
      knownApiKeys: { [REQUESTY_PROVIDER_ID]: 'my-api-key' },
    })
    const apiKeyInfo: ApiKeyInfo = { name: 'Playground', monthlySpend: 63.55, monthlyLimit: 150 }
    const { fetchApiUsage } = mockUsageDependencies([Promise.resolve(apiKeyInfo)])

    await runDiscoveryWorkflow(ctx, settings, env, '')

    expect(fetchApiUsage).toHaveBeenCalled()

    expect(capturedStatusLines).toEqual(expect.arrayContaining([expect.objectContaining({ key: USAGE_STATUS_KEY })]))
  })

  it('notifies "Discovery failed" and does not finalize when evaluation rejects (interactive)', async () => {
    const env = createTestEnv()
    const settings = createTestSettings()
    vi.mocked(DiscoveryModule.evaluateDiscovery).mockRejectedValue(new Error('models.json exploded'))
    const { runDiscoveryWorkflow } = await loadExtension()
    const { ctx, capturedNotifications } = createFakeCommandContext()

    await runDiscoveryWorkflow(ctx, settings, env, '')

    expect(DiscoveryModule.finalizeDiscovery).not.toHaveBeenCalled()
    expect(capturedNotifications).toEqual([
      { message: `${COMMAND_NAME}: Discovery failed: models.json exploded`, type: 'error' },
    ])
  })
})

describe('runDiscoveryWorkflow (print mode)', () => {
  it('passes args, settings, env and a console ui to evaluateDiscovery', async () => {
    const env = createTestEnv()
    const settings = createTestSettings()
    const evaluation = createEvaluation()
    vi.mocked(DiscoveryModule.evaluateDiscovery).mockResolvedValue(evaluation)
    vi.mocked(DiscoveryModule.finalizeDiscovery).mockResolvedValue(undefined)
    const { runDiscoveryWorkflow } = await loadExtension()
    const { ctx, capturedStatuses } = createFakeCommandContext({
      mode: 'print',
      knownApiKeys: { [REQUESTY_PROVIDER_ID]: 'my-api-key' },
    })
    const consoleSpy = vi.spyOn(console, 'log')

    await runDiscoveryWorkflow(ctx, settings, env, '--dry-run')

    const [args, evaluateSettings, evaluateEnv, evaluateUi, getApiKey] = vi.mocked(DiscoveryModule.evaluateDiscovery)
      .mock.calls[0]
    expect(args).toBe('--dry-run')
    expect(evaluateSettings).toBe(settings)
    expect(evaluateEnv).toBe(env)
    // console ui: statuses go to the console, not to a loader
    evaluateUi.setStatus('checking...')
    expect(capturedStatuses).toEqual([])
    expect(consoleSpy).toHaveBeenCalledWith('checking...')
    await expect(getApiKey(REQUESTY_PROVIDER_ID)).resolves.toBe('my-api-key')
  })

  it('passes the evaluation, settings, env and no refresh registry to finalizeDiscovery with the same console ui', async () => {
    const env = createTestEnv()
    const settings = createTestSettings()
    const evaluation = createEvaluation()
    vi.mocked(DiscoveryModule.evaluateDiscovery).mockResolvedValue(evaluation)
    vi.mocked(DiscoveryModule.finalizeDiscovery).mockResolvedValue(undefined)
    const { runDiscoveryWorkflow } = await loadExtension()
    const { ctx, capturedModelRefreshes, capturedNotifications, capturedConfirmations } = createFakeCommandContext({
      mode: 'print',
      knownApiKeys: { [REQUESTY_PROVIDER_ID]: 'my-api-key' },
    })
    const consoleSpy = vi.spyOn(console, 'log')

    await runDiscoveryWorkflow(ctx, settings, env, '')

    const [finalizeEvaluation, finalizeSettings, finalizeEnv, finalizeUi, refresh] = vi.mocked(
      DiscoveryModule.finalizeDiscovery,
    ).mock.calls[0]
    expect(finalizeEvaluation).toBe(evaluation)
    expect(finalizeSettings).toBe(settings)
    expect(finalizeEnv).toBe(env)
    // same console adapter, auto-confirm: no prompt, no ctx.ui interaction
    await expect(finalizeUi.confirm('title', 'message')).resolves.toBe(true)
    finalizeUi.notify('hello from finalize', 'warning')
    finalizeUi.setStatus('finalizing...')
    expect(refresh).toBeUndefined()
    expect(consoleSpy).toHaveBeenCalledWith('[warning] hello from finalize')
    expect(consoleSpy).toHaveBeenCalledWith('finalizing...')
    expect(capturedNotifications).toEqual([])
    expect(capturedConfirmations).toEqual([])
    expect(capturedModelRefreshes).toEqual([])
  })

  it('exercises the console ui end-to-end through both workflows', async () => {
    const env = createTestEnv()
    const settings = createTestSettings()
    vi.mocked(DiscoveryModule.evaluateDiscovery).mockImplementation(async (_args, _settings, _env, ui) => {
      ui.setStatus('Discovering Requesty models...')
      await Promise.resolve()
      return createEvaluation()
    })
    vi.mocked(DiscoveryModule.finalizeDiscovery).mockImplementation(async (_evaluation, _settings, _env, ui) => {
      const confirmed = await ui.confirm('title', 'message')
      ui.notify(`confirmed: ${confirmed}`, 'info')
    })
    const { runDiscoveryWorkflow } = await loadExtension()
    const { ctx } = createFakeCommandContext({ mode: 'print' })
    const consoleSpy = vi.spyOn(console, 'log')

    await runDiscoveryWorkflow(ctx, settings, env, '')

    expect(consoleSpy).toHaveBeenCalledWith('Discovering Requesty models...')
    expect(consoleSpy).toHaveBeenCalledWith('[info] confirmed: true')
  })

  it('skips usage status updates in non-ui mode', async () => {
    const env = createTestEnv()
    const settings = createTestSettings()
    const evaluation = createEvaluation()
    vi.mocked(DiscoveryModule.evaluateDiscovery).mockResolvedValue(evaluation)
    vi.mocked(DiscoveryModule.finalizeDiscovery).mockResolvedValue(undefined)
    const { runDiscoveryWorkflow } = await loadExtension()
    const { ctx, capturedStatusLines } = createFakeCommandContext({
      mode: 'print',
      confirmResult: true,
      knownApiKeys: { [REQUESTY_PROVIDER_ID]: 'my-api-key' },
    })
    const apiKeyInfo: ApiKeyInfo = { name: 'Playground', monthlySpend: 63.55, monthlyLimit: 150 }
    const { fetchApiUsage } = mockUsageDependencies([Promise.resolve(apiKeyInfo)])

    await runDiscoveryWorkflow(ctx, settings, env, '')

    expect(fetchApiUsage).not.toHaveBeenCalled()
    expect(capturedStatusLines).toEqual([])
  })

  it('notifies "Discovery failed" and does not finalize when evaluation rejects (silent)', async () => {
    const env = createTestEnv()
    const settings = createTestSettings()
    vi.mocked(DiscoveryModule.evaluateDiscovery).mockRejectedValue(new Error('bad day'))
    const { runDiscoveryWorkflow } = await loadExtension()
    const { ctx } = createFakeCommandContext({ mode: 'print' })
    const consoleSpy = vi.spyOn(console, 'log')

    await runDiscoveryWorkflow(ctx, settings, env, '')

    expect(DiscoveryModule.finalizeDiscovery).not.toHaveBeenCalled()
    expect(consoleSpy).toHaveBeenCalledWith('[error] Discovery failed: bad day')
  })
})

describe('tui ui adapter', () => {
  it('createTuiUi routes notify to a prefixed ctx.ui.notify', async () => {
    const { createTuiUi } = await loadExtension()
    const { ctx, capturedNotifications } = createFakeCommandContext()

    createTuiUi(ctx).notify('hello', 'info')

    expect(capturedNotifications).toEqual([{ message: `${COMMAND_NAME}: hello`, type: 'info' }])
  })

  it('createTuiUi routes confirm to ctx.ui.confirm', async () => {
    const { createTuiUi } = await loadExtension()
    const { ctx, capturedConfirmations } = createFakeCommandContext({ confirmResult: true })

    await expect(createTuiUi(ctx).confirm('title', 'message')).resolves.toBe(true)

    expect(capturedConfirmations).toEqual([{ title: 'title', message: 'message' }])
  })

  it('createTuiUi routes setStatus to the status loader', async () => {
    const { createTuiUi } = await loadExtension()
    const setMessage = vi.fn()
    const fakeLoader = { setMessage } as unknown as RequestyStatusLoader

    createTuiUi(ctxlessLoaderScope(), fakeLoader).setStatus('Discovering Requesty models...')

    expect(setMessage).toHaveBeenCalledWith('Discovering Requesty models...')
  })

  it('createTuiUi ignores setStatus when no loader is given (env-complain path has none)', async () => {
    const { createTuiUi } = await loadExtension()
    const { ctx } = createFakeCommandContext()

    expect(() => createTuiUi(ctx).setStatus('checking...')).not.toThrow()
  })

  it('refreshRegistry calls ctx.modelRegistry.refresh and resolves on success', async () => {
    const { createRefreshRegistry } = await loadExtension()
    const { ctx, capturedModelRefreshes } = createFakeCommandContext()
    const refresh = createRefreshRegistry(ctx)

    await expect(refresh()).resolves.toBeUndefined()
    expect(capturedModelRefreshes).toEqual([{ allowNetwork: false }])
  })

  it('refreshRegistry rejects on provider errors inside the refresh result', async () => {
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
    const { createRefreshRegistry } = await loadExtension()
    const refreshResult = { aborted: true, errors: new Map() }
    const { ctx } = createFakeCommandContext({ refreshResult })
    const refresh = createRefreshRegistry(ctx)

    await expect(refresh()).rejects.toThrow('refresh aborted')
  })
})

describe('console ui adapter', () => {
  it('logs level-prefixed notifications', async () => {
    const { createConsoleUi } = await loadExtension()
    const consoleSpy = vi.spyOn(console, 'log')
    const ui = createConsoleUi()

    ui.notify('hello', 'info')
    ui.notify('something weird', 'warning')
    ui.notify('boom', 'error')

    expect(consoleSpy).toHaveBeenNthCalledWith(1, '[info] hello')
    expect(consoleSpy).toHaveBeenNthCalledWith(2, '[warning] something weird')
    expect(consoleSpy).toHaveBeenNthCalledWith(3, '[error] boom')
  })

  it('logs statuses', async () => {
    const { createConsoleUi } = await loadExtension()
    const consoleSpy = vi.spyOn(console, 'log')
    const ui = createConsoleUi()

    ui.setStatus('Discovering Requesty models...')

    expect(consoleSpy).toHaveBeenCalledWith('Discovering Requesty models...')
  })

  it('always confirms: print mode is non-interactive, so writes proceed unprompted', async () => {
    const { createConsoleUi } = await loadExtension()
    const consoleSpy = vi.spyOn(console, 'log')

    await expect(createConsoleUi().confirm('title', 'message')).resolves.toBe(true)
    expect(consoleSpy).not.toHaveBeenCalled()
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

  describe('sets the usage status line', () => {
    it.each(events)('on %s', async eventName => {
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
      const { fetchApiUsage } = mockUsageDependencies()
      const { eventHandlers } = await loadExtension()
      const { ctx, capturedStatusLines } = createFakeCommandContext({ hasUI: false })

      await fireEvent(eventHandlers, 'turn_end', ctx)

      expect(capturedStatusLines).toEqual([])
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
    warningCount: 0,
    passing: [],
    diff: { added: [], removed: [] },
    healthCheckSummary: '',
    logNote: '',
    data: { providers: {} },
    ...overrides,
  }
}

function createTestEnv(): Env {
  return {
    models_json_path: MODELS_JSON_PATH,
    health_check_log_path: HEALTH_CHECK_LOG_PATH,
    settings_path: SETTINGS_PATH,
  }
}

function createTestSettings(): DiscoverySettings {
  return {
    healthCheckMode: 'basic',
    providerId: DEFAULT_PROVIDER_ID,
    bannedModels: [],
  }
}
