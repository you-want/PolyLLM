import { access, constants, cp, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../../../apps/studio/dist/', import.meta.url))
const target = fileURLToPath(new URL('../dist/studio-ui/', import.meta.url))

try {
  await access(source, constants.F_OK)
} catch {
  throw new Error('Studio UI build output is missing. Run the workspace build first.')
}

await rm(target, { recursive: true, force: true })
await mkdir(dirname(target), { recursive: true })
await cp(source, target, { recursive: true })
