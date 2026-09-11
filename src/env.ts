import path from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'

export type Env = {
  models_json_path: string
  health_check_log_path: string
  settings_path: string
}

export function getEnv(): Env {
  const agentPath = getAgentDir()
  return {
    models_json_path: path.join(agentPath, 'models.json'),
    health_check_log_path: path.join(agentPath, 'requesty-health-check.log'),
    settings_path: path.join(agentPath, 'requesty-discovery-settings.json5'),
  }
}
