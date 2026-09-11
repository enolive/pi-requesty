import fs from 'node:fs'
import { parse as JSON5Parse } from 'json5'
import { prettifyError, z } from 'zod'
import { type Env } from './env'
import { formatErrorMessage } from './utils'

export const DEFAULT_PROVIDER_ID = 'requesty-export'

const HealthCheckModeSchema = z.enum(['off', 'basic', 'full']).default('full')

const DiscoverySettingsSchema = z
  .object({
    bannedModels: z.array(z.string().min(1)).default([]),
    healthCheckMode: HealthCheckModeSchema,
    providerId: z.string().default(DEFAULT_PROVIDER_ID),
  })
  .strip()

export type DiscoverySettings = z.infer<typeof DiscoverySettingsSchema>

/**
 * Reads the discovery settings file (JSON5, so it supports comments).
 * Returns defaults when the file does not exist; throws when it exists but is invalid.
 */
export function readDiscoverySettings(envConfig: Env): DiscoverySettings {
  if (!fs.existsSync(envConfig.settings_path)) {
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
