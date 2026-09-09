import { ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import { type Env } from './env'
import {
  ApiKeyProvider,
  diffModels,
  formatModelsDiffSummary,
  getRequestyConfig,
  type ModelsDiff,
  ModelsJson,
  updateModelsJson,
} from './models-json'
import { checkModels, formatHealthSummary, writeHealthCheckLog } from './health-check'
import { discoverModels } from './requesty-api'

const DRY_RUN_ARG = '--dry-run'

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

export type Refresher = {
  refresh(): Promise<void>
}

export type StatusReporter = {
  set(message: string): void
}

export type DiscoveryEvaluation = {
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

export function formatDiscoveryFailure(error: unknown): string {
  const detail = formatError(error)
  return `Discovery failed: ${detail}`
}

export async function evaluateDiscovery(
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

export async function finalizeDiscovery(
  evaluation: DiscoveryEvaluation,
  env: Env,
  confirmer: Confirmer,
  notifier: Notifier,
  refresher: Refresher,
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
    const refreshResult = await runCatchingAsync(() => refresher.refresh())
    if (refreshResult.ok) {
      notifier.notify('Updated models.json. New models are available in /model.', 'info')
    } else {
      notifier.notify(
        `Updated models.json, but the model registry could not be refreshed: ${formatError(refreshResult.error)}. Run /reload or restart Pi to use the changes.`,
        'warning',
      )
    }
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

export function getArgumentCompletions(prefix: string): AutocompleteItem[] {
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

export function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function runCatching<T>(fn: () => T): Try<T> {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, error }
  }
}

export async function runCatchingAsync<T>(fn: () => Promise<T>): Promise<Try<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error }
  }
}

export function complainOnBrokenEnv(notifier: Notifier, env: Try<Env>) {
  if (!env.ok) {
    notifier.notify(`failed to load env: ${formatError(env.error)}`, 'error')
  }
}
