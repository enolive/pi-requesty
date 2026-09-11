import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Env } from './env'
import { DEFAULT_PROVIDER_ID, readDiscoverySettings } from './settings'
import { createTempDirectory, TempDirectory } from '../test/helpers/temp-agent.ts'

describe('readDiscoverySettings', () => {
  let tempDir: TempDirectory
  let env: Env

  beforeEach(async () => {
    tempDir = await createTempDirectory()
    env = createEnv(tempDir)
  })

  afterEach(async () => {
    await tempDir.clean()
  })

  it('returns default settings when the file does not exist', () => {
    const settings = readDiscoverySettings(env)

    expect(settings).toEqual({ bannedModels: [], healthCheckMode: 'full', providerId: DEFAULT_PROVIDER_ID })
  })

  it('reads banned models from a json5 file with comments', async () => {
    await fs.writeFile(
      env.settings_path,
      `{
  // banned because it hangs on tool calls
  bannedModels: [
    'requesty/unstable-model',
    /* another one */ 'requesty/another-unstable',
  ],
}`,
      'utf8',
    )

    const settings = readDiscoverySettings(env)

    expect(settings.bannedModels).toEqual(['requesty/unstable-model', 'requesty/another-unstable'])
  })

  it('defaults providerId to default when omitted', async () => {
    await fs.writeFile(env.settings_path, '{ other: true }', 'utf8')

    const settings = readDiscoverySettings(env)

    expect(settings.providerId).toEqual(DEFAULT_PROVIDER_ID)
  })

  it('defaults healthCheckMode to default when omitted', async () => {
    await fs.writeFile(env.settings_path, '{ other: true }', 'utf8')

    const settings = readDiscoverySettings(env)

    expect(settings.healthCheckMode).toEqual('full')
  })

  it('defaults bannedModels to empty when omitted', async () => {
    await fs.writeFile(env.settings_path, '{ other: true }', 'utf8')

    const settings = readDiscoverySettings(env)

    expect(settings.bannedModels).toEqual([])
  })

  it('rejects a file with invalid json5 syntax', async () => {
    await fs.writeFile(env.settings_path, '{ bannedModels: [', 'utf8')

    expect(() => readDiscoverySettings(env)).toThrow(/Failed to parse/)
  })

  it('rejects a file with wrong schema', async () => {
    await fs.writeFile(env.settings_path, '{ bannedModels: "not-a-list" }', 'utf8')

    expect(() => readDiscoverySettings(env)).toThrow(/requesty-discovery-settings\.json5 is invalid/)
  })

  it('rejects bannedModels entries that are not strings', async () => {
    await fs.writeFile(env.settings_path, '{ bannedModels: [42] }', 'utf8')

    expect(() => readDiscoverySettings(env)).toThrow(/requesty-discovery-settings\.json5 is invalid/)
  })
})

function createEnv(dir: TempDirectory): Env {
  return {
    models_json_path: dir.modelsJsonPath,
    health_check_log_path: dir.healthCheckLogPath,
    settings_path: dir.settingsPath,
  }
}
