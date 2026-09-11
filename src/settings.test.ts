import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Env, DEFAULT_PROVIDER_ID } from './env'
import { readDiscoverySettings } from './settings'

describe('readDiscoverySettings', () => {
  let tempDir: string
  let env: Env

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-requesty-settings-'))
    env = createEnv(tempDir)
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('returns default settings when the file does not exist', () => {
    const settings = readDiscoverySettings(env)

    expect(settings).toEqual({ bannedModels: [] })
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

  it('defaults bannedModels to empty when omitted', async () => {
    await fs.writeFile(env.settings_path, '{ other: true }', 'utf8')

    const settings = readDiscoverySettings(env)

    expect(settings).toEqual({ bannedModels: [] })
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

function createEnv(dir: string): Env {
  return {
    models_json_path: path.join(dir, 'models.json'),
    health_check_log_path: path.join(dir, 'requesty-health-check.log'),
    settings_path: path.join(dir, 'requesty-discovery-settings.json5'),
    provider_id: DEFAULT_PROVIDER_ID,
    health_check_mode: 'basic',
  }
}
