import { z } from 'zod'

/**
 * Runtime validation of every environment variable the backend reads.
 *
 * The schema is the single source of truth: it fails fast at startup with an
 * actionable message instead of letting an invalid value surface later as a
 * confusing runtime error deep inside the application.
 *
 * Cross-field rules are enforced here too, so that a configuration that is
 * merely "valid per variable" but unsafe as a whole — such as production with
 * insecure cookies, or a Gemini provider with no credential — cannot start.
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

/**
 * Parses an explicit boolean string.
 *
 * Deliberately not `z.coerce.boolean()`, which treats any non-empty string —
 * including `"false"` — as `true`. A security setting must not be invertible by
 * a typo.
 */
const booleanString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')

/** Splits a comma-separated list, trimming and dropping empty entries. */
function splitCommaSeparated(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * A comma-separated list, parsed after the default is applied.
 *
 * The default is attached to the raw string and the transform runs afterwards,
 * so the fallback is a plain comma-separated string like any other input rather
 * than a pre-split array. That keeps the environment variable's documented
 * format identical whether it is set or defaulted.
 */

const DEFAULT_DEVELOPMENT_ORIGINS =
  'http://localhost:5173,http://127.0.0.1:5173'

export const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),

    HOST: z.string().min(1).default('0.0.0.0'),

    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    /**
     * Proxy headers are only honoured when a real reverse proxy sets them.
     * Defaults to false: trusting `X-Forwarded-For` from an untrusted caller
     * would let a client forge its own address and defeat rate limiting.
     */
    TRUST_PROXY: booleanString.default(false),

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

    // -----------------------------------------------------------------------
    // Authentication and sessions
    // -----------------------------------------------------------------------

    /** Lifetime of a login session. */
    AUTH_SESSION_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(12),

    /**
     * Whether the session cookie carries `Secure`. Production must set this to
     * `true`; the cross-field rule below refuses to start otherwise.
     */
    COOKIE_SECURE: booleanString.optional(),

    /** Requests allowed per window against the authentication endpoints. */
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(10),

    AUTH_RATE_LIMIT_WINDOW_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_440)
      .default(15),

    // -----------------------------------------------------------------------
    // Browser origins
    // -----------------------------------------------------------------------

    /**
     * Exact origins allowed to call the API and to appear in `Origin` on
     * state-changing requests. A wildcard is never accepted: cookie-based
     * authentication plus a reflecting CORS policy is a cross-site request
     * forgery hole.
     */
    CORS_ALLOWED_ORIGINS: z
      .string()
      .default(DEFAULT_DEVELOPMENT_ORIGINS)
      .transform(splitCommaSeparated),

    // -----------------------------------------------------------------------
    // Local file storage for uploaded evidence
    // -----------------------------------------------------------------------

    /** Private directory for stored uploads. Git-ignored; never web-served. */
    UPLOAD_DIR: z.string().min(1).default('./.local-storage/uploads'),

    UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(100 * 1024 * 1024)
      .default(5 * 1024 * 1024),

    // -----------------------------------------------------------------------
    // Extraction providers
    // -----------------------------------------------------------------------

    /**
     * Which extraction provider the worker uses.
     *
     * `mock` is the default so that the whole pipeline runs deterministically
     * with no credentials and no network access, in development and in tests.
     * `auto` prefers Gemini and falls back to Groq when both are configured.
     * An explicitly named provider with no credential is refused at startup.
     */
    EXTRACTION_PROVIDER: z
      .enum(['mock', 'gemini', 'groq', 'auto'])
      .default('mock'),

    EXTRACTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(120_000)
      .default(30_000),

    GEMINI_API_KEY: z.string().min(1).optional(),
    GEMINI_MODEL: z.string().min(1).default('gemini-2.5-flash'),

    GROQ_API_KEY: z.string().min(1).optional(),
    GROQ_MODEL: z.string().min(1).default('openai/gpt-oss-20b'),

    // -----------------------------------------------------------------------
    // Background worker
    // -----------------------------------------------------------------------

    /** How long a claimed job is leased before another worker may reclaim it. */
    WORKER_LEASE_SECONDS: z.coerce.number().int().min(5).max(3_600).default(60),

    /** Job attempts before a job is marked failed. */
    WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),

    /** Delay before the first retry; doubles on each subsequent attempt. */
    WORKER_RETRY_BACKOFF_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3_600)
      .default(5),

    /** Idle poll interval when the queue is empty. */
    WORKER_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(50)
      .max(60_000)
      .default(1_000),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === 'production') {
      if (value.COOKIE_SECURE !== true) {
        ctx.addIssue({
          code: 'custom',
          path: ['COOKIE_SECURE'],
          message: 'must be "true" when NODE_ENV is production',
        })
      }

      if (value.CORS_ALLOWED_ORIGINS.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ALLOWED_ORIGINS'],
          message: 'must list at least one origin when NODE_ENV is production',
        })
      }
    }

    for (const origin of value.CORS_ALLOWED_ORIGINS) {
      if (origin === '*') {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ALLOWED_ORIGINS'],
          message: 'must not contain "*": cookie authentication requires exact origins',
        })
      }
      try {
        const parsed = new URL(origin)
        if (parsed.origin !== origin) {
          ctx.addIssue({
            code: 'custom',
            path: ['CORS_ALLOWED_ORIGINS'],
            message: `"${origin}" must be a bare origin such as https://app.example.com`,
          })
        }
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ALLOWED_ORIGINS'],
          message: `"${origin}" is not a valid origin`,
        })
      }
    }

    if (value.EXTRACTION_PROVIDER === 'gemini' && !value.GEMINI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['GEMINI_API_KEY'],
        message: 'is required when EXTRACTION_PROVIDER is gemini',
      })
    }

    if (value.EXTRACTION_PROVIDER === 'groq' && !value.GROQ_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['GROQ_API_KEY'],
        message: 'is required when EXTRACTION_PROVIDER is groq',
      })
    }
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

/**
 * Effective `Secure` flag for session cookies.
 *
 * Production always returns `true`, independently of the schema rule above, so
 * a future caller cannot construct a production configuration that omits it.
 */
export function useSecureCookies(env: Environment): boolean {
  if (env.NODE_ENV === 'production') return true
  return env.COOKIE_SECURE ?? false
}

/** A log-safe summary of the active configuration. Never includes secrets. */
export function describeEnvironment(env: Environment): Record<string, unknown> {
  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    trustProxy: env.TRUST_PROXY,
    databaseUrl: redactConnectionString(env.DATABASE_URL),
    databasePoolMax: env.DATABASE_POOL_MAX,
    sessionTtlHours: env.AUTH_SESSION_TTL_HOURS,
    secureCookies: useSecureCookies(env),
    corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS,
    uploadDir: env.UPLOAD_DIR,
    uploadMaxBytes: env.UPLOAD_MAX_BYTES,
    extractionProvider: env.EXTRACTION_PROVIDER,
    // Presence only — never the value.
    geminiConfigured: env.GEMINI_API_KEY !== undefined,
    groqConfigured: env.GROQ_API_KEY !== undefined,
    workerLeaseSeconds: env.WORKER_LEASE_SECONDS,
    workerMaxAttempts: env.WORKER_MAX_ATTEMPTS,
  }
}
