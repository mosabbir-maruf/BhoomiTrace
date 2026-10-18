import { randomBytes, randomUUID } from 'node:crypto'

import { loadEnvironment } from '../config/env.js'
import { loadEnvFile } from '../config/load-env.js'
import { createDatabase, databaseConfigFromEnvironment } from '../db/client.js'
import { systemActor } from '../services/audit.js'
import { provisionPrivilegedAccount } from '../services/auth.js'

/**
 * Creates a reviewer or administrator account: `npm run db:admin -- --email ...`.
 *
 * ## Why a CLI and not a route
 *
 * There is no HTTP route, no request field, and no environment variable that can
 * produce a role other than `applicant`. If there were, privilege would be one
 * bug away from being self-assigned. Provisioning is therefore an out-of-band
 * operator action that requires shell access to the host, and the resulting
 * account carries an audit entry naming the root actor `cli`.
 *
 * ## Idempotent by default
 *
 * Running it twice for the same address does not replace the password of the
 * existing account; it reports that the account already existed. Replacing a
 * password requires `--reset-password`, so a repeated command cannot lock
 * somebody out by accident. Any password change revokes that account's sessions.
 *
 * ## The password
 *
 * If `--password` is omitted, a random one is generated and printed once. The
 * value is never written to a log or a file, and only its Argon2id hash reaches
 * the database.
 *
 * Usage:
 *   npm run db:admin -- --email you@example.com --role admin --name "Op Name"
 *   npm run db:admin -- --email r@example.com --role reviewer --password '...'
 */

interface ParsedArguments {
  email: string
  role: 'reviewer' | 'admin'
  name: string
  password?: string
  resetPassword: boolean
}

class UsageError extends Error {}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const values = new Map<string, string | true>()

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined || !token.startsWith('--')) {
      throw new UsageError(`Unexpected argument: ${String(token)}`)
    }

    const key = token.slice(2)
    if (key === 'reset-password') {
      values.set(key, true)
      continue
    }

    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      throw new UsageError(`--${key} requires a value`)
    }
    values.set(key, next)
    index += 1
  }

  const email = values.get('email')
  if (typeof email !== 'string' || email.length === 0) {
    throw new UsageError('--email is required')
  }

  const role = values.get('role') ?? 'admin'
  if (role !== 'reviewer' && role !== 'admin') {
    throw new UsageError('--role must be "reviewer" or "admin"')
  }

  const nameValue = values.get('name')
  const password = values.get('password')

  return {
    email,
    role,
    name: typeof nameValue === 'string' ? nameValue : `${role} account`,
    ...(typeof password === 'string' ? { password } : {}),
    resetPassword: values.get('reset-password') === true,
  }
}

/** A random password with enough entropy to clear the length policy. */
function generatePassword(): string {
  // 32 random bytes as base64url: 43 characters, well above the minimum length.
  return randomBytes(32).toString('base64url')
}

function usage(): string {
  return [
    'Usage: npm run db:admin -- --email <address> [--role reviewer|admin]',
    '                             [--name "<display name>"] [--password <secret>]',
    '                             [--reset-password]',
    '',
    'Creates a reviewer or administrator account, or gives an existing account',
    'that role. Without --password a strong one is generated and printed once.',
    'Without --reset-password an existing account keeps its current password.',
  ].join('\n')
}

loadEnvFile()

const parsed = ((): ParsedArguments => {
  try {
    return parseArguments(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Invalid arguments'}\n\n${usage()}\n`,
    )
    process.exit(2)
  }
})()

const env = loadEnvironment()
const database = createDatabase(databaseConfigFromEnvironment(env))

const password = parsed.password ?? generatePassword()

try {
  const result = await provisionPrivilegedAccount(database, {
    email: parsed.email,
    displayName: parsed.name,
    password,
    role: parsed.role,
    actor: systemActor('cli'),
    resetPassword: parsed.resetPassword,
    requestId: `cli-${randomUUID()}`,
  })

  const lines = [
    result.created
      ? `Created ${result.user.role} account ${result.user.email}.`
      : `Account ${result.user.email} now has the ${result.user.role} role.`,
    result.created || result.passwordChanged
      ? 'The password for this account is set to the value below.'
      : 'The existing password was left unchanged (pass --reset-password to replace it).',
  ]

  if (result.created || result.passwordChanged) {
    lines.push('', `  password: ${password}`, '', 'Store it in a password manager now; it is not shown again.')
  }

  process.stdout.write(`${lines.join('\n')}\n`)
} catch (error) {
  process.stderr.write(
    `Failed to provision the account: ${
      error instanceof Error ? error.message : 'unknown error'
    }\n`,
  )
  process.exitCode = 1
} finally {
  await database.close()
}
