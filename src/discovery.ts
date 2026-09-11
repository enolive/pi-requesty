import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import { type Env } from './env'
import {
  type GetApiKey,
  type ModelsDiff,
  type ModelsJson,
  diffModels,
  formatModelsDiffSummary,
  getRequestyConfig,
  updateModelsJson,
} from './models-json'
import { checkModels, formatHealthSummary, writeHealthCheckLog } from './health-check'
import { discoverModels } from './requesty-api'
import type { DiscoverySettings } from './settings'
import { formatErrorMessage, runCatchingAsync } from './utils'

const DRY_RUN_ARG = '--dry-run'

interface AutocompleteItem {
  value: string
  label: string
  description: string
}

export type NotificationLevel = 'info' | 'warning' | 'error'

/** Everything the discovery workflow needs from the UI. One port, two adapters (tui/console) in index.ts. */
export type DiscoveryUi = {
  notify(message: string, level: NotificationLevel): void
  confirm(title: string, message: string): Promise<boolean>
  setStatus(message: string): void
}

export type RefreshModelsRegistry = () => Promise<void>

export type DiscoveryEvaluation = {
  dryRun: boolean
  modelCount: number
  failedCount: number
  warningCount: number
  passing: ProviderModelConfig[]
  diff: ModelsDiff
  healthCheckSummary: string
  logNote: string
  data: ModelsJson
}

export function formatDiscoveryFailure(error: unknown): string {
  const detail = formatErrorMessage(error)
  return `Discovery failed: ${detail}`
}

export async function evaluateDiscovery(
  args: string,
  settings: DiscoverySettings,
  env: Env,
  ui: DiscoveryUi,
  getApiKey: GetApiKey,
): Promise<DiscoveryEvaluation> {
  ui.setStatus('Discovering Requesty models...')
  const dryRun = args.split(' ').includes(DRY_RUN_ARG)

  const { data, provider, existingModelIds } = await getRequestyConfig(getApiKey, settings, env)
  const bannedModels = new Set(settings.bannedModels)
  const allModels = await discoverModels(provider)
  const foundBannedModels = allModels
    .filter(model => bannedModels.has(model.id))
    .map(model => model.id)
    .toSorted()
  const models = allModels.filter(model => !bannedModels.has(model.id))
  const modelsMap = new Map(models.map(m => [m.id, m]))

  let diff: ModelsDiff
  let failedCount = 0
  let warningCount = 0
  let passing: ProviderModelConfig[] = []
  let logNote = ''
  let healthCheckSummary = ''

  if (settings.healthCheckMode !== 'off') {
    if (models.length > 0) {
      ui.setStatus(`Checking models 0/${models.length}...`)
      const healthResults = await checkModels(provider, models, settings.healthCheckMode === 'full', {
        onProgress: ({ completed, total }) => {
          ui.setStatus(`Checking models ${completed}/${total}...`)
        },
      })
      const sortedResults = healthResults.toSorted((a, b) => a.modelId.localeCompare(b.modelId))
      failedCount = sortedResults.filter(r => r.status === 'error').length
      warningCount = sortedResults.filter(r => r.status === 'warning').length
      passing = sortedResults.flatMap(r => {
        const model = modelsMap.get(r.modelId)
        if (!model) return []
        if (r.status === 'ok') return [model]
        // warnings are transient: assume that the error will go away and add them anyway
        if (r.status === 'warning') return [model]
        return []
      })
      healthCheckSummary = formatHealthSummary(sortedResults)
      writeHealthCheckLog(
        provider,
        sortedResults,
        diffModels(existingModelIds, passing),
        { providerId: settings.providerId, bannedModels: foundBannedModels },
        env,
      )
    }
    diff = diffModels(existingModelIds, passing)
    logNote = `Full health check log: ${env.health_check_log_path}\n`
  } else {
    passing = models
    diff = diffModels(existingModelIds, passing)
  }

  return {
    dryRun,
    modelCount: models.length,
    failedCount,
    warningCount,
    passing,
    diff,
    healthCheckSummary,
    logNote,
    data,
  }
}

export async function finalizeDiscovery(
  evaluation: DiscoveryEvaluation,
  settings: DiscoverySettings,
  env: Env,
  ui: DiscoveryUi,
  refresh?: RefreshModelsRegistry,
): Promise<void> {
  const level = notificationLevel(evaluation)
  const summary = buildDiscoverySummary(evaluation)

  // Always surface the discovery result first (toast styling), then decide.
  if (evaluation.dryRun) {
    ui.notify(
      `${summary}
Dry run: left models.json unchanged.`,
      level,
    )
    return
  }

  if (evaluation.passing.length === 0) {
    ui.notify(
      `${summary}
Left models.json unchanged.`,
      level,
    )
    return
  }

  ui.notify(summary, level)
  const { title, message } = buildConfirmPrompt(evaluation)
  const shouldUpdate = await ui.confirm(title, message)
  if (shouldUpdate) {
    updateModelsJson(evaluation.data, evaluation.passing, settings, env)
    if (!refresh) {
      ui.notify('Updated models.json.', 'info')
      return
    }
    const refreshResult = await runCatchingAsync(() => refresh())
    if (refreshResult.ok) {
      ui.notify('Updated models.json. New models are available in /model.', 'info')
    } else {
      ui.notify(
        `Updated models.json, but the model registry could not be refreshed: ${formatErrorMessage(refreshResult.error)}. Run /reload or restart Pi to use the changes.`,
        'warning',
      )
    }
    return
  }

  ui.notify('Left models.json unchanged.', 'info')
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
  if (evaluation.failedCount > 0) return 'error'
  if (evaluation.warningCount > 0) return 'warning'
  return 'info'
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
