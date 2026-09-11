import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getEnv } from './env'
import os from 'node:os'

const TEST_HOME_DIR = '/tmp/pi-requesty-home'
const REQUESTY_ENV_KEYS = ['PI_CODING_AGENT_DIR'] as const

describe('getEnv', () => {
  beforeEach(() => {
    deleteRequestyEnv()
  })

  afterEach(() => {
    deleteRequestyEnv()
  })

  it('uses provided homeDir', () => {
    process.env.PI_CODING_AGENT_DIR = TEST_HOME_DIR
    const envConfig = getEnv()

    expect(envConfig.models_json_path).toBe(`${TEST_HOME_DIR}/models.json`)
    expect(envConfig.health_check_log_path).toBe(`${TEST_HOME_DIR}/requesty-health-check.log`)
    expect(envConfig.settings_path).toBe(`${TEST_HOME_DIR}/requesty-discovery-settings.json5`)
  })

  it('falls back to the config dir provided by pi', () => {
    const defaultHomeDir = os.homedir()
    delete process.env.PI_CODING_AGENT_DIR

    const envConfig = getEnv()

    expect(envConfig.models_json_path).toBe(`${defaultHomeDir}/.pi/agent/models.json`)
    expect(envConfig.health_check_log_path).toBe(`${defaultHomeDir}/.pi/agent/requesty-health-check.log`)
    expect(envConfig.settings_path).toBe(`${defaultHomeDir}/.pi/agent/requesty-discovery-settings.json5`)
  })
})

function deleteRequestyEnv() {
  for (const key of REQUESTY_ENV_KEYS) {
    delete process.env[key]
  }
}
