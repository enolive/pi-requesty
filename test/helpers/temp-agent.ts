import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface TempDirectory {
  homeDir: string
  agentDir: string
  modelsJsonPath: string
  healthCheckLogPath: string
  settingsPath: string

  clean(): Promise<void>
}

export async function createTempDirectory(): Promise<TempDirectory> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-requesty-'))
  const agentDir = path.join(homeDir, '.pi', 'agent')
  const modelsJsonPath = path.join(agentDir, 'models.json')
  const healthCheckLogPath = path.join(agentDir, 'requesty-health-check.log')
  const settingsPath = path.join(agentDir, 'requesty-discovery-settings.json5')

  await fs.mkdir(agentDir, { recursive: true })

  return {
    homeDir,
    agentDir,
    modelsJsonPath,
    healthCheckLogPath,
    settingsPath,
    async clean() {
      await fs.rm(homeDir, { recursive: true, force: true })
    },
  }
}
