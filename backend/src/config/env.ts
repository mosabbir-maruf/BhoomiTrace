import { z } from 'zod'

/**
 * Runtime validation of every environment variable the backend reads.
 *
 * The schema is the single source of truth: it fails fast at startup with an
 * actionable message instead of letting an invalid value surface later as a
 * confusing runtime error deep inside the application.
 */

/** Accepts only PostgreSQL connection strings. */
function isPostgresConnectionString(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:'
  } catch {
    return false
  }
}

export const environmentSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  HOST: z.string().min(1).default('0.0.0.0'),

  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  DATABASE_URL: z
    .string()
    .refine(isPostgresConnectionString, {
      message: 'must be a postgres:// or postgresql:// connection string',
    }),

  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  DATABASE_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(120_000)
    .default(5_000),
})

export type Environment = z.infer<typeof environmentSchema>

/** Raised when the process environment does not satisfy `environmentSchema`. */
export class EnvironmentValidationError extends Error {
  override readonly name = 'EnvironmentValidationError'

  constructor(readonly issues: readonly string[]) {
    super(
      `Invalid environment configuration:\n${issues
        .map((issue) => `  - ${issue}`)
        .join('\n')}`,
    )
  }
}

/**
 * Parses and validates an environment record. Reads `process.env` by default.
 *
 * @throws {EnvironmentValidationError} when validation fails.
 */
export function loadEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Environment {
  const result = environmentSchema.safeParse(source)

  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    )
    throw new EnvironmentValidationError(issues)
  }

  return result.data
}

/** Replaces the password in a connection string so it is safe to log. */
export function redactConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString)
    if (url.password) url.password = '***'
    return url.toString()
  } catch {
    return '<unparseable connection string>'
  }
}

/** A log-safe summary of the active configuration. Never includes secrets. */
export function describeEnvironment(env: Environment): Record<string, unknown> {
  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: redactConnectionString(env.DATABASE_URL),
    databasePoolMax: env.DATABASE_POOL_MAX,
  }
}
