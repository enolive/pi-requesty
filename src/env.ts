import path from 'node:path'
import process from 'node:process'
import { prettifyError, z } from 'zod'
import { getAgentDir } from '@earendil-works/pi-coding-agent'

const HealthCheckModeSchema = z.enum(['off', 'basic', 'full']).default('full')

export const DEFAULT_PROVIDER_ID = 'requesty-export'

export type Env = {
  models_json_path: string
  health_check_log_path: string
  provider_id: string
  health_check_mode: z.infer<typeof HealthCheckModeSchema>
}

export function getEnv(): Env {
  const envVars = process.env
  const result = HealthCheckModeSchema.safeParse(envVars.REQUESTY_HEALTH_CHECK_MODE)
  if (!result.success) {
    throw new Error(prettifyError(result.error))
  }

  const agentPath = getAgentDir()
  return {
    models_json_path: path.join(agentPath, 'models.json'),
    health_check_log_path: path.join(agentPath, 'requesty-health-check.log'),
    provider_id: envVars.REQUESTY_PROVIDER_ID ?? DEFAULT_PROVIDER_ID,
    health_check_mode: result.data,
  }
}
