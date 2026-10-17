/**
 * Loads a `.env` file into `process.env` using Node's built-in loader.
 *
 * Node 24 provides `process.loadEnvFile`, so no environment-file dependency is
 * needed. The file is optional: a missing `.env` is not an error, because
 * production and CI supply real environment variables instead.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export function loadEnvFile(path = resolve(process.cwd(), '.env')): boolean {
  if (!existsSync(path)) return false
  process.loadEnvFile(path)
  return true
}
