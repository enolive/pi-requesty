import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { DiscoverySettingsSchema } from '../src/settings'

const OUT_PATH = path.resolve('docs/requesty-discovery-settings.schema.json')
const SCHEMA_URL =
  'https://raw.githubusercontent.com/enolive/pi-requesty/main/docs/requesty-discovery-settings.schema.json'

const schema = z.toJSONSchema(DiscoverySettingsSchema, { target: 'draft-2020-12', io: 'output' })
schema.$id = SCHEMA_URL
schema.title = 'Requesty discovery settings'
schema.description = 'Settings for the pi-requesty discovery extension. The file uses JSON5, so comments are allowed.'

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true })
fs.writeFileSync(OUT_PATH, `${JSON.stringify(schema, null, 2)}\n`, 'utf8')
console.log(`wrote ${OUT_PATH}`)
