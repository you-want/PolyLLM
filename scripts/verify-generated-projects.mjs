import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createDefaultSelection, generateProjectFiles } from '../packages/studio/dist/index.js'

const root = resolve(new URL('..', import.meta.url).pathname)
const typescriptCli = await realpath(join(root, 'packages', 'studio', 'node_modules', 'typescript', 'bin', 'tsc'))
const nodeTypes = await realpath(join(root, 'packages', 'cli', 'node_modules', '@types', 'node'))
const undiciTypes = await realpath(join(nodeTypes, '..', '..', 'undici-types'))

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options })
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed`,
      result.error?.message,
      result.signal ? `signal: ${result.signal}` : '',
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }
  return result.stdout
}

async function writeGeneratedProject(directory, files) {
  for (const file of files) {
    const path = join(directory, file.path)
    await mkdir(resolve(path, '..'), { recursive: true })
    await writeFile(path, file.content, 'utf8')
  }
  const combined = files.map((file) => file.content).join('\n')
  if (combined.includes('generated-secret')) throw new Error('Generated project leaked an API key')
}

function selection(language) {
  const value = createDefaultSelection()
  value.projectName = language === 'python' ? 'generated-python-app' : 'generated-typescript-app'
  value.language = language
  value.packageManager = language === 'python' ? 'pip' : 'pnpm'
  value.providers.openai.models = ['gpt-4o-mini']
  value.providers.openai.defaultModel = 'gpt-4o-mini'
  value.providers.deepseek.enabled = true
  value.providers.deepseek.models = ['deepseek-chat']
  value.providers.deepseek.defaultModel = 'deepseek-chat'
  return value
}

async function verifyTypeScript(directory) {
  const project = join(directory, 'typescript')
  await writeGeneratedProject(project, generateProjectFiles(selection('typescript')))
  const scope = join(project, 'node_modules', '@you-want')
  await mkdir(scope, { recursive: true })
  for (const name of ['core', 'openai', 'deepseek']) {
    await symlink(join(root, 'packages', name), join(scope, `polyllm-${name}`), 'dir')
  }
  await mkdir(join(project, 'node_modules', '@types'), { recursive: true })
  await symlink(nodeTypes, join(project, 'node_modules', '@types', 'node'), 'dir')
  await symlink(undiciTypes, join(project, 'node_modules', 'undici-types'), 'dir')
  run(process.execPath, [typescriptCli, '-p', join(project, 'tsconfig.json')], { cwd: project })
}

async function verifyPython(directory) {
  const project = join(directory, 'python')
  await writeGeneratedProject(project, generateProjectFiles(selection('python')))
  const stubs = join(project, 'stubs', 'dotenv')
  await mkdir(stubs, { recursive: true })
  await writeFile(join(stubs, '__init__.py'), 'def load_dotenv():\n    return False\n', 'utf8')
  const pythonPaths = [
    join(project, 'src'),
    join(project, 'stubs'),
    ...['core', 'openai', 'openai-compatible', 'deepseek', 'anthropic'].map((name) => join(root, 'python', 'packages', name, 'src')),
  ]
  const environment = {
    ...process.env,
    PYTHONPATH: pythonPaths.join(delimiter),
    OPENAI_API_KEY: 'generated-secret',
    DEEPSEEK_API_KEY: 'generated-secret',
  }
  run('python3', ['-c', 'import tomllib, pathlib; tomllib.loads(pathlib.Path("pyproject.toml").read_text())'], { cwd: project, env: environment })
  run('python3', ['-m', 'compileall', '-q', 'src'], { cwd: project, env: environment })
  run('python3', ['-c', 'from generated_python_app.llm import default_model, llm; assert default_model == "openai:gpt-4o-mini"; assert llm.get_model_info(default_model) is not None'], { cwd: project, env: environment })
}

const directory = await mkdtemp(join(tmpdir(), 'polyllm-generated-projects-'))
try {
  await verifyTypeScript(directory)
  await verifyPython(directory)
  console.log('Generated TypeScript and Python projects verified.')
} finally {
  await rm(directory, { recursive: true, force: true })
}
