import { access, constants, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const distDirectory = fileURLToPath(new URL('../dist/', import.meta.url))
const indexPath = join(distDirectory, 'index.html')
const html = await readFile(indexPath, 'utf8')
const publicFiles = await readdir(distDirectory)
const cssFiles = publicFiles.filter((file) => file.endsWith('.css'))

if (cssFiles.length === 0) {
  throw new Error('Website build failed: no CSS asset was generated.')
}

if (!cssFiles.some((file) => html.includes(`/${file}`))) {
  throw new Error('Website build failed: index.html does not reference a generated stylesheet.')
}

if (/<input/i.test(html) || /type=["']password["']/i.test(html)) {
  throw new Error('Website build failed: the public site must not contain input controls.')
}

for (const requiredFile of ['CNAME', 'favicon.svg']) {
  await access(join(distDirectory, requiredFile), constants.F_OK)
}

console.log(`Website build verified: ${cssFiles.length} stylesheet(s), no key input controls.`)
