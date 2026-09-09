import {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ProviderModelConfig,
} from '@earendil-works/pi-coding-agent'
import { type Env, getEnv } from './env'
import {
  ApiKeyProvider,
  diffModels,
  formatModelsDiffSummary,
  getRequestyConfig,
  type ModelsDiff,
  ModelsJson,
  updateModelsJson,
} from './models-json'
import { type ApiKeyInfo, discoverModels, fetchApiUsage } from './requesty-api'
import { checkModels, formatHealthSummary, writeHealthCheckLog } from './health-check'
import { RequestyStatusLoader } from './ui/requesty-status-loader.ts'

const COMMAND_NAME = 'requesty-discover'
const DRY_RUN_ARG = '--dry-run'
export const USAGE_STATUS_KEY = 'requesty-usage'

interface AutocompleteItem {
  value: string
  label: string
  description: string
}

export type NotificationLevel = 'info' | 'warning' | 'error'

export type Notifier = {
  notify(message: string, level: NotificationLevel): void
}

export type Confirmer = {
  confirm(title: string, message: string): Promise<boolean>
}

export type StatusReporter = {
  set(message: string): void
}

type DiscoveryEvaluation = {
  dryRun: boolean
  modelCount: number
  failedCount: number
  passing: ProviderModelConfig[]
  diff: ModelsDiff
  healthCheckSummary: string
  logNote: string
  data: ModelsJson
}

export type Try<T> = { ok: true; value: T } | { ok: false; error: unknown }

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
  if (!env.ok) return

  const confirmer = createUiConfirmer(ctx)
  const apiProvider = createApiKeyProvider(ctx)

  // Phase A: progress UI only. Loader must close before confirm (Phase B).
  // Errors are wrapped because ctx.ui.custom resolves via done() and does not reject.
  const evaluationResult: Try<DiscoveryEvaluation> = await runWithStatusUi(
    ctx,
    'Discovering models...',
    async status => await runCatchingAsync(() => evaluateDiscovery(args, env.value, status, apiProvider)),
  )

  if (!evaluationResult.ok) {
    notifier.notify(formatDiscoveryFailure(evaluationResult.error), 'error')
    return
  }

  // Phases B + C: decide, optional write, final notify — outside the loader.
  await finalizeDiscovery(evaluationResult.value, confirmer, notifier, env.value)
}

export async function runSilentDiscoveryWorkflow(ctx: ExtensionCommandContext, env: Try<Env>, args: string) {
  const notifier = createConsoleNotifier()
  complainOnBrokenEnv(notifier, env)
  if (!env.ok) return
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

function formatDiscoveryFailure(error: unknown): string {
  const detail = formatError(error)
  return `Discovery failed: ${detail}`
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

async function evaluateDiscovery(
  args: string,
  env: Env,
  status: StatusReporter,
  apiKeyProvider: ApiKeyProvider,
): Promise<DiscoveryEvaluation> {
  status.set('Discovering Requesty models...')
  const dryRun = args.split(' ').includes(DRY_RUN_ARG)

  const { data, provider, existingModelIds } = await getRequestyConfig(apiKeyProvider, env)
  const models = await discoverModels(provider)
  const modelsMap = new Map(models.map(m => [m.id, m]))

  let diff: ModelsDiff
  let failedCount = 0
  let passing: ProviderModelConfig[]
  let logNote = ''
  let healthCheckSummary = ''

  if (env.health_check_mode !== 'off') {
    status.set(`Checking models 0/${models.length}...`)
    const healthResults = await checkModels(provider, models, env.health_check_mode === 'full', {
      onProgress: ({ completed, total }) => {
        status.set(`Checking models ${completed}/${total}...`)
      },
    })
    const sortedResults = healthResults.toSorted((a, b) => a.modelId.localeCompare(b.modelId))
    failedCount = sortedResults.filter(r => !r.ok).length
    passing = sortedResults.flatMap(r => {
      const model = modelsMap.get(r.modelId)
      return r.ok && model ? [model] : []
    })
    diff = diffModels(existingModelIds, passing)
    healthCheckSummary = formatHealthSummary(sortedResults)
    writeHealthCheckLog(provider, sortedResults, diff, env)
    logNote = `Full health check log: ${env.health_check_log_path}\n`
  } else {
    passing = models
    diff = diffModels(existingModelIds, passing)
  }

  return {
    dryRun,
    modelCount: models.length,
    failedCount,
    passing,
    diff,
    healthCheckSummary,
    logNote,
    data,
  }
}

async function finalizeDiscovery(
  evaluation: DiscoveryEvaluation,
  confirmer: Confirmer,
  notifier: Notifier,
  env: Env,
): Promise<void> {
  const level = notificationLevel(evaluation)
  const summary = buildDiscoverySummary(evaluation)

  // Always surface the discovery result first (toast styling), then decide.
  if (evaluation.dryRun) {
    notifier.notify(
      `${summary}
Dry run: left models.json unchanged.`,
      level,
    )
    return
  }

  if (evaluation.passing.length === 0) {
    notifier.notify(
      `${summary}
Left models.json unchanged.`,
      level,
    )
    return
  }

  notifier.notify(summary, level)
  const { title, message } = buildConfirmPrompt(evaluation)
  const shouldUpdate = await confirmer.confirm(title, message)
  if (shouldUpdate) {
    updateModelsJson(evaluation.data, evaluation.passing, env)
    notifier.notify('Updated models.json. Run /reload to use the changes.', 'info')
    return
  }

  notifier.notify('Left models.json unchanged.', 'info')
}

function buildDiscoverySummary(evaluation: DiscoveryEvaluation): string {
  return [
    `Discovered ${evaluation.modelCount} Requesty model(s).`,
    evaluation.healthCheckSummary.trimEnd(),
    formatModelsDiffSummary(evaluation.diff),
    evaluation.logNote.trimEnd(),
  ]
    .filter(part => part.length > 0)
    .join('\n')
}

function buildConfirmPrompt(evaluation: DiscoveryEvaluation): { title: string; message: string } {
  const hasIdChanges = evaluation.diff.added.length > 0 || evaluation.diff.removed.length > 0
  if (hasIdChanges) {
    return {
      title: `Write ${evaluation.passing.length} model(s)?`,
      message: 'Update models.json with the discovery result above.',
    }
  }
  return {
    title: 'Refresh models.json?',
    message: 'No model ID changes. Rewrite the file to refresh metadata anyway?',
  }
}

function notificationLevel(evaluation: DiscoveryEvaluation): NotificationLevel {
  if (evaluation.failedCount === 0) return 'info'
  if (evaluation.failedCount < evaluation.modelCount) return 'warning'
  return 'error'
}

function getArgumentCompletions(prefix: string): AutocompleteItem[] {
  const options = [
    {
      value: DRY_RUN_ARG,
      label: DRY_RUN_ARG,
      description: 'Preview discovery without offering to write models.json',
    },
  ]
  if (!prefix) return options
  return options.filter(o => o.value.toLowerCase().startsWith(prefix.toLowerCase()))
}

function createUiNotifier(ctx: ExtensionContext): Notifier {
  return {
    notify(message: string, level?: NotificationLevel) {
      const prefixedMessage = `${COMMAND_NAME}: ${message}`
      ctx.ui.notify(prefixedMessage, level)
    },
  }
}

function createUiConfirmer(ctx: ExtensionContext): Confirmer {
  return {
    confirm(title, message) {
      return ctx.ui.confirm(title, message)
    },
  }
}

function createLoaderStatusReporter(loader: RequestyStatusLoader): StatusReporter {
  return {
    set(message: string) {
      loader.setMessage(message)
    },
  }
}

function createConsoleNotifier(): Notifier {
  return {
    notify: (message: string, _level: NotificationLevel) => console.log(`[${_level}] ${message}`),
  }
}

function createConsoleStatusReporter(): StatusReporter {
  return {
    set: (message: string) => console.log(message),
  }
}

function createNoopConfirmer(): Confirmer {
  return {
    confirm: () => Promise.resolve(true),
  }
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

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * For testing purposes, reset the cache after each run
 */
export function resetUsageStatusCache(): void {
  lastFetched = undefined
}

function runCatching<T>(fn: () => T): Try<T> {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, error }
  }
}

async function runCatchingAsync<T>(fn: () => Promise<T>): Promise<Try<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error }
  }
}

function complainOnBrokenEnv(notifier: Notifier, env: Try<Env>) {
  if (!env.ok) {
    notifier.notify(`failed to load env: ${formatError(env.error)}`, 'error')
  }
}

/**
 * minimal abstraction for getting an API key to not pollute anything outside index.ts with too many pi internals.
 */
function createApiKeyProvider(ctx: ExtensionContext): ApiKeyProvider {
  return {
    async getApiKey(providerId: string) {
      return ctx.modelRegistry.getApiKeyForProvider(providerId)
    },
  }
}
