import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROVIDER_ID, getEnv } from './env'
import os from 'node:os'

const TEST_HOME_DIR = '/tmp/pi-requesty-home'
const REQUESTY_ENV_KEYS = [
  'REQUESTY_API_KEY',
  'REQUESTY_PROVIDER_ID',
  'REQUESTY_HEALTH_CHECK_MODE',
  'PI_CODING_AGENT_DIR',
] as const

describe('getEnv', () => {
  beforeEach(() => {
    deleteRequestyEnv()
    process.env.REQUESTY_API_KEY = 'api-key'
  })

  afterEach(() => {
    deleteRequestyEnv()
  })

  it('defaults provider ID to requesty-export', () => {
    const envConfig = getEnv()

    expect(envConfig.provider_id).toBe(DEFAULT_PROVIDER_ID)
  })

  it('defaults health check mode to full', () => {
    const envConfig = getEnv()

    expect(envConfig.health_check_mode).toBe('full')
  })

  it('accepts off health check mode', () => {
    process.env.REQUESTY_HEALTH_CHECK_MODE = 'off'

    const envConfig = getEnv()

    expect(envConfig.health_check_mode).toBe('off')
  })

  it('accepts basic health check mode', () => {
    process.env.REQUESTY_HEALTH_CHECK_MODE = 'basic'

    const envConfig = getEnv()

    expect(envConfig.health_check_mode).toBe('basic')
  })

  it('accepts full health check mode', () => {
    process.env.REQUESTY_HEALTH_CHECK_MODE = 'full'

    const envConfig = getEnv()

    expect(envConfig.health_check_mode).toBe('full')
  })

  it('rejects invalid health check mode', () => {
    process.env.REQUESTY_HEALTH_CHECK_MODE = 'invalid'

    const createEnv = () => getEnv()

    expect(createEnv).toThrow(/Invalid option/)
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

  it('reads REQUESTY_PROVIDER_ID', () => {
    process.env.REQUESTY_PROVIDER_ID = 'custom-provider'

    const envConfig = getEnv()

    expect(envConfig.provider_id).toBe('custom-provider')
  })
})

function deleteRequestyEnv() {
  for (const key of REQUESTY_ENV_KEYS) {
    delete process.env[key]
  }
}
