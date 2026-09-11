import fs from 'node:fs'
import path from 'node:path'
import { parse as JSON5Parse } from 'json5'
import { prettifyError, z } from 'zod'
import { type Env } from './env'
import { formatErrorMessage } from './utils'

export const DEFAULT_PROVIDER_ID = 'requesty-export'

const HealthCheckModeSchema = z.enum(['off', 'basic', 'full']).default('full')

export const DiscoverySettingsSchema = z
  .object({
    bannedModels: z.array(z.string().min(1)).default([]),
    healthCheckMode: HealthCheckModeSchema,
    providerId: z.string().default(DEFAULT_PROVIDER_ID),
  })
  .strip()

export type DiscoverySettings = z.infer<typeof DiscoverySettingsSchema>

const SCHEMA_URL =
  'https://raw.githubusercontent.com/enolive/pi-requesty/main/docs/requesty-discovery-settings.schema.json'

/**
 * Reads the discovery settings file (JSON5, so it supports comments).
 * Writes a commented default file (including the $schema editor reference) when it does not
 * exist yet; throws when it exists but is invalid.
 */
export function readDiscoverySettings(envConfig: Env): DiscoverySettings {
  if (!fs.existsSync(envConfig.settings_path)) {
    writeDefaultSettingsFile(envConfig)
    return {
      bannedModels: [],
      healthCheckMode: 'full',
      providerId: DEFAULT_PROVIDER_ID,
    }
  }

  const raw = fs.readFileSync(envConfig.settings_path, 'utf8')
  let data: unknown
  try {
    data = JSON5Parse(raw)
  } catch (error) {
    throw new Error(`Failed to parse ${envConfig.settings_path}: ${formatErrorMessage(error)}`, { cause: error })
  }

  const result = DiscoverySettingsSchema.safeParse(data)
  if (!result.success) {
    throw new Error(`${envConfig.settings_path} is invalid: ${prettifyError(result.error)}`)
  }
  return result.data
}

function writeDefaultSettingsFile(envConfig: Env): void {
  const content = `{
  $schema: "${SCHEMA_URL}",
  // the provider id in models.json whose models are managed by this extension
  providerId: "${DEFAULT_PROVIDER_ID}",
  // health check mode: "full" (basic + reasoning/tool check), "basic", or "off"
  healthCheckMode: "full",
  // models excluded from discovery; useful for models that keep failing health checks
  bannedModels: []
}
`
  fs.mkdirSync(path.dirname(envConfig.settings_path), { recursive: true })
  fs.writeFileSync(envConfig.settings_path, content, 'utf8')
}
