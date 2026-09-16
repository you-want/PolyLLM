#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parsePolyLLMConfig, readPolyLLMConfig } from './config.js'
import { doctorConfig, listSelectedModels } from './doctor.js'
import { generateProjectFiles } from './project.js'
import { startStudioServer } from './studio-server.js'

interface CliOptions {
  command?: string
  target?: string
  configPath: string
  projectName: string
  studioHost: string
  studioPort: number
  openStudio: boolean
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    configPath: 'polyllm.config.json',
    projectName: 'polyllm-app',
    studioHost: '127.0.0.1',
    studioPort: 5177,
    openStudio: true,
  }
  const [command, ...args] = argv
  options.command = command
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--config') options.configPath = args[++index] ?? options.configPath
    else if (arg === '--dir') options.target = args[++index]
    else if (arg === '--name') options.projectName = args[++index] ?? options.projectName
    else if (arg === '--host') options.studioHost = args[++index] ?? options.studioHost
    else if (arg === '--port') {
      const port = Number(args[++index])
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('无效的 Studio 端口')
      options.studioPort = port
    }
    else if (arg === '--no-open') options.openStudio = false
    else throw new Error(`未知参数: ${arg}`)
  }
  return options
}

async function initProject(options: CliOptions): Promise<void> {
  const configPath = resolve(options.configPath)
  const config = await readPolyLLMConfig(configPath)
  const target = resolve(options.target ?? '.')
  const files = generateProjectFiles(config, {
    projectName: options.projectName,
  })
  for (const file of files) {
    const path = resolve(target, file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.content, 'utf8')
  }
  console.log(`PolyLLM 项目已生成: ${target}`)
  console.log('下一步:')
  console.log('  1. pnpm install')
  console.log('  2. cp .env.example .env')
  console.log('  3. pnpm build && pnpm start')
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (!options.command || ['help', '--help', '-h'].includes(options.command)) {
    console.log(`PolyLLM CLI\n\n用法:\n  polyllm studio [--host 127.0.0.1] [--port 5177] [--no-open]\n  polyllm init --config polyllm.config.json --dir ./my-app\n  polyllm doctor --config polyllm.config.json\n  polyllm models --config polyllm.config.json\n`)
    return
  }

  if (options.command === 'studio') {
    await startStudioServer({
      host: options.studioHost,
      port: options.studioPort,
      open: options.openStudio,
    })
    return
  }

  if (options.command === 'init') {
    await initProject(options)
    return
  }

  const config = await readPolyLLMConfig(resolve(options.configPath))
  if (options.command === 'doctor') {
    const result = doctorConfig(config)
    for (const check of result.checks) console.log(`${check.ok ? '✓' : '✗'} ${check.name}: ${check.message}`)
    if (!result.ok) process.exitCode = 1
    return
  }

  if (options.command === 'models') {
    for (const model of listSelectedModels(config)) console.log(model)
    return
  }

  throw new Error(`未知命令: ${options.command}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
