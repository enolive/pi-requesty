import { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { type Env, getEnv } from './env'
import { ApiKeyProvider, getRequestyConfig } from './models-json'
import { type ApiKeyInfo, fetchApiUsage } from './requesty-api'
import { RequestyStatusLoader } from './ui/requesty-status-loader.ts'
import {
  complainOnBrokenEnv,
  type Confirmer,
  DiscoveryEvaluation,
  evaluateDiscovery,
  finalizeDiscovery,
  formatDiscoveryFailure,
  getArgumentCompletions,
  type Notifier,
  type NotificationLevel,
  runCatching,
  runCatchingAsync,
  type StatusReporter,
  type Try,
} from './discovery'

export { type Try }

const COMMAND_NAME = 'requesty-discover'
export const USAGE_STATUS_KEY = 'requesty-usage'

// token suppresses stale writes when turns overlap
let latestToken: object = {}

// noinspection JSUnusedGlobalSymbols
export default function (pi: ExtensionAPI) {
  const env = runCatching(() => getEnv())

  pi.registerCommand(COMMAND_NAME, {
    description: 'Dynamically discover Requesty models, run health checks, and update the local models.json.',
    getArgumentCompletions,
    handler: async (args, ctx) => {
      await runDiscoveryWorkflow(ctx, env, args)
    },
  })

  pi.on('turn_end', (_event, ctx) => {
    void updateUsageStatus(ctx, env)
  })

  pi.on('session_start', (_event, ctx) => {
    const notifier = createUiNotifier(ctx)
    complainOnBrokenEnv(notifier, env)
    void updateUsageStatus(ctx, env)
  })

  pi.on('model_select', (_event, ctx) => {
    void updateUsageStatus(ctx, env)
  })
}

export async function runDiscoveryWorkflow(ctx: ExtensionCommandContext, env: Try<Env>, args: string) {
  if (ctx.mode === 'tui') {
    return runInteractiveDiscoveryWorkflow(ctx, env, args)
  } else {
    return runSilentDiscoveryWorkflow(ctx, env, args)
  }
}

export async function runInteractiveDiscoveryWorkflow(ctx: ExtensionCommandContext, env: Try<Env>, args: string) {
  const notifier = createUiNotifier(ctx)
  complainOnBrokenEnv(notifier, env)
  if (!env.ok) {
    return
  }

  const confirmer = createUiConfirmer(ctx)
  const apiProvider = createApiKeyProvider(ctx)

  const evaluationResult: Try<DiscoveryEvaluation> = await runWithStatusUi(
    ctx,
    'Discovering models...',
    async status => await runCatchingAsync(() => evaluateDiscovery(args, env.value, status, apiProvider)),
  )

  if (!evaluationResult.ok) {
    notifier.notify(formatDiscoveryFailure(evaluationResult.error), 'error')
    return
  }

  await finalizeDiscovery(evaluationResult.value, confirmer, notifier, env.value)
}

export async function runSilentDiscoveryWorkflow(ctx: ExtensionCommandContext, env: Try<Env>, args: string) {
  const notifier = createConsoleNotifier()
  complainOnBrokenEnv(notifier, env)
  if (!env.ok) {
    return
  }

  const apiProvider = createApiKeyProvider(ctx)
  const status = createConsoleStatusReporter()
  const confirmer = createNoopConfirmer()

  const evaluationResult: Try<DiscoveryEvaluation> = await runCatchingAsync(() =>
    evaluateDiscovery(args, env.value, status, apiProvider),
  )

  if (!evaluationResult.ok) {
    notifier.notify(formatDiscoveryFailure(evaluationResult.error), 'error')
    return
  }

  await finalizeDiscovery(evaluationResult.value, confirmer, notifier, env.value)
}

async function runWithStatusUi<T>(
  ctx: ExtensionCommandContext,
  initialMessage: string,
  fn: (status: StatusReporter) => Promise<T>,
): Promise<T> {
  return ctx.ui.custom<T>((tui, theme, _kb, done) => {
    const loader = new RequestyStatusLoader(tui, theme, initialMessage)
    const status = createLoaderStatusReporter(loader)
    void Promise.resolve()
      .then(() => fn(status))
      .then(done)
      .catch(done)
    return loader
  })
}

async function updateUsageStatus(ctx: ExtensionContext, env: Try<Env>): Promise<void> {
  if (!env.ok) return
  if (!ctx.hasUI) return // no footer to write to (print/json mode): skip the wasted fetch
  const token: object = {}
  latestToken = token
  const shouldClear = ctx.model?.provider !== env.value.provider_id
  try {
    if (shouldClear) {
      ctx.ui.setStatus(USAGE_STATUS_KEY, undefined)
      return
    }
    const apiKeyProvider = createApiKeyProvider(ctx)
    const info = await fetchUsageStatus(apiKeyProvider, env.value)
    if (latestToken !== token) return
    ctx.ui.setStatus(USAGE_STATUS_KEY, formatUsageStatus(info))
  } catch {
    // best-effort footer update: swallow fetch errors and stale-ctx throws (e.g. after /reload)
  }
}

export function formatUsageStatus(info: ApiKeyInfo): string {
  const spend = `$${info.monthlySpend.toFixed(2)}`
  if (info.monthlyLimit <= 0) {
    return `${info.name}: ${spend} (unlimited)`
  }
  const limit = `$${info.monthlyLimit.toFixed(2)}`
  const percent = Math.floor((info.monthlySpend / info.monthlyLimit) * 100)
  return `${info.name}: ${spend}/${limit} (${percent}%)`
}

let lastFetched: { value: ApiKeyInfo; time: Date } | undefined

async function fetchUsageStatus(apiKeyProvider: ApiKeyProvider, env: Env): Promise<ApiKeyInfo> {
  const now = new Date()
  if (lastFetched?.time && now.getTime() - lastFetched.time.getTime() < 2000) {
    return lastFetched.value
  }
  const { provider } = await getRequestyConfig(apiKeyProvider, env)
  const value = await fetchApiUsage(provider)
  lastFetched = { value, time: new Date() }
  return value
}

/**
 * For testing purposes, reset the cache after each run
 */
export function resetUsageStatusCache(): void {
  lastFetched = undefined
}

/**
 * minimal abstraction for getting an API key to not pollute anything outside index.ts with too many pi internals.
 */
export function createApiKeyProvider(ctx: ExtensionContext): ApiKeyProvider {
  return {
    async getApiKey(providerId: string) {
      return ctx.modelRegistry.getApiKeyForProvider(providerId)
    },
  }
}

export function createUiNotifier(ctx: ExtensionContext): Notifier {
  return {
    notify(message: string, level?: NotificationLevel) {
      const prefixedMessage = `${COMMAND_NAME}: ${message}`
      ctx.ui.notify(prefixedMessage, level)
    },
  }
}

export function createUiConfirmer(ctx: ExtensionContext): Confirmer {
  return {
    confirm(title, message) {
      return ctx.ui.confirm(title, message)
    },
  }
}

export function createLoaderStatusReporter(loader: RequestyStatusLoader): StatusReporter {
  return {
    set(message: string) {
      loader.setMessage(message)
    },
  }
}

export function createConsoleNotifier(): Notifier {
  return {
    notify: (message: string, _level: NotificationLevel) => console.log(`[${_level}] ${message}`),
  }
}

export function createConsoleStatusReporter(): StatusReporter {
  return {
    set: (message: string) => console.log(message),
  }
}

export function createNoopConfirmer(): Confirmer {
  return {
    confirm: () => Promise.resolve(true),
  }
}
