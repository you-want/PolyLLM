//! Agent config adapter (magpie-style "pick any model for any agent"):
//! points a Claude Code installation at the gateway by editing its own
//! settings file, with backup/restore. Only Claude Code is supported in this
//! prototype; subscription discovery is deliberately out of scope.

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const BACKUP_SUFFIX = '.polyllm-backup'
const GATEWAY_TOKEN = 'polyllm-local-gateway'

export interface ClaudeCodeApplyResult {
  settingsPath: string
  backupPath: string | null
  previous: { baseUrl?: string; authToken?: string } | undefined
}

function readSettings(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  return JSON.parse(raw) as Record<string, unknown>
}

/** Point Claude Code at the gateway (idempotent). Backs up the original
 *  settings once; keeps any pre-existing gateway-unrelated env intact. */
export async function applyClaudeCodeAdapter(
  settingsPath: string,
  gatewayUrl: string,
): Promise<ClaudeCodeApplyResult> {
  let settings: Record<string, unknown> = {}
  let raw = ''
  try {
    raw = await readFile(settingsPath, 'utf8')
    settings = readSettings(raw)
  } catch {
    settings = {}
  }

  const env = { ...((settings.env as Record<string, unknown> | undefined) ?? {}) }
  const previous: { baseUrl?: string; authToken?: string } = {}
  if (typeof env.ANTHROPIC_BASE_URL === 'string') previous.baseUrl = env.ANTHROPIC_BASE_URL
  if (typeof env.ANTHROPIC_AUTH_TOKEN === 'string') previous.authToken = env.ANTHROPIC_AUTH_TOKEN

  await mkdir(dirname(settingsPath), { recursive: true })
  const backupPath = `${settingsPath}${BACKUP_SUFFIX}`
  if (raw && previous.baseUrl !== gatewayUrl) {
    await copyFile(settingsPath, backupPath)
  }

  env.ANTHROPIC_BASE_URL = gatewayUrl
  env.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN === GATEWAY_TOKEN ? GATEWAY_TOKEN : GATEWAY_TOKEN
  settings.env = env

  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  return { settingsPath, backupPath: raw ? backupPath : null, previous }
}

/** Restore the pre-gateway settings (removes the gateway override). */
export async function restoreClaudeCodeAdapter(settingsPath: string): Promise<boolean> {
  const backupPath = `${settingsPath}${BACKUP_SUFFIX}`
  try {
    const backup = await readFile(backupPath, 'utf8')
    await writeFile(settingsPath, backup, 'utf8')
    return true
  } catch {
    // No backup: remove our keys from an existing settings file if present.
    try {
      const raw = await readFile(settingsPath, 'utf8')
      const settings = readSettings(raw)
      const env = { ...((settings.env as Record<string, unknown> | undefined) ?? {}) }
      delete env.ANTHROPIC_BASE_URL
      delete env.ANTHROPIC_AUTH_TOKEN
      settings.env = env
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      return true
    } catch {
      return false
    }
  }
}
