import { and, eq, lt, sql } from 'drizzle-orm'

import type { Database } from '../db/client.js'
import { authSessions, type AuthSession } from '../db/schema/sessions.js'
import { users, type User } from '../db/schema/users.js'
import type { UserRole } from '../db/schema/enums.js'
import { ConflictError, UnauthorizedError } from '../lib/errors.js'
import { hashPassword, verifyPasswordOrDecoy } from '../lib/password.js'
import { issueToken, sha256Hex, timingSafeEqualStrings } from '../lib/tokens.js'
import { AuditActions, recordAuditEvent, systemActor, type AuditActor } from './audit.js'

/**
 * Registration, login, and session lifecycle.
 *
 * Two rules shape this module:
 *
 * 1. Nothing the client sends decides privilege. Registration always produces
 *    an `applicant`; only the bootstrap CLI and an administrator can produce any
 *    other role. There is no code path that reads a role from a request body.
 * 2. Failures do not disclose which accounts exist. An unknown email and a wrong
 *    password produce the same error, and cost the same time, because the
 *    unknown-account path still performs one Argon2id verification.
 */

/** A user representation safe to return over HTTP. Never includes a hash. */
export interface PublicUser {
  id: string
  email: string
  displayName: string
  role: UserRole
  status: 'active' | 'suspended'
  createdAt: string
}

/**
 * Strips the password hash.
 *
 * Every response that contains a user goes through this, so `password_hash`
 * cannot reach a caller by accident.
 */
export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  }
}

/** Emails are stored and compared case-insensitively. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

export interface SessionConfig {
  ttlHours: number
}

/** A freshly issued session: the tokens exist only in this return value. */
export interface IssuedSession {
  /** Opaque session token; goes into the HTTP-only cookie and nowhere else. */
  token: string
  /** CSRF token; goes into the readable cookie and the echoed header. */
  csrfToken: string
  session: AuthSession
}

export interface RegisterInput {
  email: string
  password: string
  displayName: string
}

/**
 * Creates an applicant account.
 *
 * The role is hard-coded here and is not a parameter, so no request can promote
 * itself. A duplicate email is a 409 rather than a silent success, because
 * silently accepting a second registration for the same address would mask an
 * account-takeover attempt.
 */
export async function registerApplicant(
  database: Database,
  input: RegisterInput,
): Promise<PublicUser> {
  const email = normaliseEmail(input.email)
  const passwordHash = await hashPassword(input.password)

  return database.orm.transaction(async (tx) => {
    const existing = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1)

    if (existing.length > 0) {
      throw new ConflictError('An account with that email already exists.')
    }

    const inserted = await tx
      .insert(users)
      .values({
        email,
        passwordHash,
        displayName: input.displayName.trim(),
        // Never taken from the request.
        role: 'applicant',
        status: 'active',
      })
      .returning()

    const user = inserted[0]
    if (user === undefined) {
      throw new Error('Registration did not return the created user.')
    }

    await recordAuditEvent(tx, {
      actor: { kind: 'user', userId: user.id, role: user.role },
      action: AuditActions.userRegistered,
      entityType: 'user',
      entityId: user.id,
      summary: 'Applicant account registered.',
      // The email is the account's own; the password is never included.
      changes: { role: user.role, status: user.status },
    })

    return toPublicUser(user)
  })
}

export interface AuthenticateInput {
  email: string
  password: string
  requestId?: string | null
}

/**
 * Verifies credentials and returns the account.
 *
 * Always the same error for every failure mode, and always one Argon2id
 * verification, so response content and timing cannot distinguish "no such
 * account" from "wrong password" or "suspended".
 */
export async function authenticateCredentials(
  database: Database,
  input: AuthenticateInput,
): Promise<User> {
  const email = normaliseEmail(input.email)

  const rows = await database.orm
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1)

  const user = rows[0]

  const passwordMatches = await verifyPasswordOrDecoy(
    user?.passwordHash ?? null,
    input.password,
  )

  const acceptable =
    user !== undefined && user.status === 'active' && passwordMatches

  if (!acceptable) {
    // A refused sign-in has no authenticated actor. Naming the targeted account
    // as the actor would put a claim in the trail that the account holder did
    // something, and would let anyone who knows an address write rows against
    // it. The account is recorded as the *entity* the event concerns; the actor
    // is the authentication subsystem, exactly as for an unknown address.
    await recordAuditEvent(database.orm, {
      actor: systemActor('auth'),
      action: AuditActions.loginFailed,
      entityType: 'user',
      entityId: user?.id ?? null,
      summary:
        user !== undefined && user.status === 'suspended'
          ? 'Login refused: account is suspended.'
          : 'Login refused: credentials did not match.',
      requestId: input.requestId ?? null,
    })

    throw new UnauthorizedError('Email or password is incorrect.')
  }

  await recordAuditEvent(database.orm, {
    actor: { kind: 'user', userId: user.id, role: user.role },
    action: AuditActions.loginSucceeded,
    entityType: 'user',
    entityId: user.id,
    summary: 'Login succeeded.',
    requestId: input.requestId ?? null,
  })

  return user
}

/** Creates a session row and returns the plaintext tokens exactly once. */
export async function createSession(
  database: Database,
  userId: string,
  config: SessionConfig,
  context: { userAgent?: string | null } = {},
): Promise<IssuedSession> {
  const session = issueToken()
  const csrf = issueToken()
  const expiresAt = new Date(Date.now() + config.ttlHours * 60 * 60 * 1000)

  const inserted = await database.orm
    .insert(authSessions)
    .values({
      userId,
      tokenHash: session.tokenHash,
      csrfTokenHash: csrf.tokenHash,
      // Truncated: a user-agent is diagnostic, not a Fingerprint.
      userAgent: context.userAgent?.slice(0, 300) ?? null,
      expiresAt,
    })
    .returning()

  const row = inserted[0]
  if (row === undefined) {
    throw new Error('Session insert did not return a row.')
  }

  return { token: session.token, csrfToken: csrf.token, session: row }
}

export type SessionResolution =
  | { outcome: 'active'; session: AuthSession; user: User }
  | { outcome: 'missing' }
  | { outcome: 'expired' }
  | { outcome: 'suspended' }

/**
 * Resolves a session token to its account.
 *
 * Expired rows are deleted as they are encountered, so the table self-cleans
 * without an operator having to run anything. A suspended account has every
 * session revoked at the moment the suspension is noticed, so a status change
 * takes effect immediately rather than at the next expiry.
 */
export async function resolveSessionToken(
  database: Database,
  token: string,
): Promise<SessionResolution> {
  const tokenHash = sha256Hex(token)

  const rows = await database.orm
    .select({ session: authSessions, user: users })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(eq(authSessions.tokenHash, tokenHash))
    .limit(1)

  const row = rows[0]
  if (row === undefined) return { outcome: 'missing' }

  if (row.session.expiresAt.getTime() <= Date.now()) {
    await database.orm
      .delete(authSessions)
      .where(eq(authSessions.id, row.session.id))
    return { outcome: 'expired' }
  }

  if (row.user.status !== 'active') {
    await revokeAllSessionsForUser(database, row.user.id)
    return { outcome: 'suspended' }
  }

  await database.orm
    .update(authSessions)
    .set({ lastUsedAt: new Date() })
    .where(eq(authSessions.id, row.session.id))

  return { outcome: 'active', session: row.session, user: row.user }
}

/**
 * Confirms a CSRF token belongs to the session.
 *
 * Compares digests rather than plaintext, so the comparison never handles the
 * stored value directly, and uses a timing-safe equality so the check does not
 * leak how much of a guess was correct.
 */
export function csrfTokenMatches(session: AuthSession, candidate: string): boolean {
  return timingSafeEqualStrings(sha256Hex(candidate), session.csrfTokenHash)
}

/** Deletes one session. Returns whether a row was removed. */
export async function revokeSession(
  database: Database,
  token: string,
): Promise<boolean> {
  const deleted = await database.orm
    .delete(authSessions)
    .where(eq(authSessions.tokenHash, sha256Hex(token)))
    .returning({ id: authSessions.id })

  return deleted.length > 0
}

/** Deletes one session by its identifier. */
export async function revokeSessionById(
  database: Database,
  sessionId: string,
): Promise<boolean> {
  const deleted = await database.orm
    .delete(authSessions)
    .where(eq(authSessions.id, sessionId))
    .returning({ id: authSessions.id })

  return deleted.length > 0
}

/** Deletes every session for an account. Used on suspension and password change. */
export async function revokeAllSessionsForUser(
  database: Database,
  userId: string,
): Promise<number> {
  const deleted = await database.orm
    .delete(authSessions)
    .where(eq(authSessions.userId, userId))
    .returning({ id: authSessions.id })

  return deleted.length
}

/** Removes expired rows. Safe to call from a timer; idempotent. */
export async function sweepExpiredSessions(database: Database): Promise<number> {
  const deleted = await database.orm
    .delete(authSessions)
    .where(lt(authSessions.expiresAt, new Date()))
    .returning({ id: authSessions.id })

  return deleted.length
}

/** Looks up an account by email, case-insensitively. */
export async function findAccountByEmail(
  database: Database,
  email: string,
): Promise<User | null> {
  const rows = await database.orm
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${normaliseEmail(email)}`)
    .limit(1)

  return rows[0] ?? null
}

export interface PrivilegedAccountInput {
  email: string
  displayName: string
  password: string
  role: UserRole
  /** Who performed the bootstrap, for the audit row. */
  actor: AuditActor
  /** Replace the password of an existing account instead of leaving it alone. */
  resetPassword?: boolean
  requestId?: string | null
}

export interface PrivilegedAccountResult {
  user: PublicUser
  created: boolean
  passwordChanged: boolean
}

/**
 * Creates a reviewer or administrator account, or updates an existing one.
 *
 * This is the only code path that can write a role other than `applicant`. It
 * lives in the service layer and is reached solely from the bootstrap CLI, so
 * there is no HTTP route, no request field, and no environment variable that
 * could promote an account.
 *
 * Idempotent by default: running it again for an existing account leaves that
 * account's password untouched and reports `passwordChanged: false`. Replacing a
 * password requires `resetPassword: true`, so an accidental second run cannot
 * lock somebody out.
 */
export async function provisionPrivilegedAccount(
  database: Database,
  input: PrivilegedAccountInput,
): Promise<PrivilegedAccountResult> {
  const email = normaliseEmail(input.email)
  const passwordHash = await hashPassword(input.password)

  return database.orm.transaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1)

    const existing = existingRows[0]

    if (existing === undefined) {
      const inserted = await tx
        .insert(users)
        .values({
          email,
          passwordHash,
          displayName: input.displayName.trim(),
          role: input.role,
          status: 'active',
        })
        .returning()

      const user = inserted[0]
      if (user === undefined) {
        throw new Error('Account provisioning did not return the created user.')
      }

      await recordAuditEvent(tx, {
        actor: input.actor,
        action: AuditActions.accountBootstrapped,
        entityType: 'user',
        entityId: user.id,
        summary: `${input.role} account provisioned out of band.`,
        changes: { role: user.role, status: user.status, created: true },
        requestId: input.requestId ?? null,
      })

      return { user: toPublicUser(user), created: true, passwordChanged: true }
    }

    const shouldResetPassword = input.resetPassword === true

    const updated = await tx
      .update(users)
      .set({
        // The role is raised deliberately here, and only here.
        role: input.role,
        ...(shouldResetPassword ? { passwordHash } : {}),
      })
      .where(eq(users.id, existing.id))
      .returning()

    const user = updated[0]
    if (user === undefined) {
      throw new Error('Account provisioning did not return the updated user.')
    }

    if (shouldResetPassword) {
      // A password change invalidates outstanding sessions, so a credential
      // that may have leaked stops working immediately.
      await tx.delete(authSessions).where(eq(authSessions.userId, user.id))
    }

    await recordAuditEvent(tx, {
      actor: input.actor,
      action: AuditActions.accountBootstrapped,
      entityType: 'user',
      entityId: user.id,
      summary: shouldResetPassword
        ? `Existing account given the ${input.role} role; stored password replaced.`
        : `Existing account given the ${input.role} role; stored password left unchanged.`,
      changes: {
        before: { role: existing.role },
        after: { role: user.role },
        // Whether a reset was applied, which is a different fact from what the
        // password now is. It is named for the action rather than for the
        // secret because audit details are redacted by key name: a key called
        // `passwordChanged` was blanked to `[redacted]` by the guard, which lost
        // the very fact an operator needs to read here. Nothing about the
        // password's value is recorded, in this field or any other.
        resetApplied: shouldResetPassword,
        created: false,
      },
      requestId: input.requestId ?? null,
    })

    return {
      user: toPublicUser(user),
      created: false,
      passwordChanged: shouldResetPassword,
    }
  })
}

/** Suspends an account and revokes its sessions in one transaction. */
export async function suspendAccount(
  database: Database,
  userId: string,
  reason: string,
): Promise<number> {
  return database.orm.transaction(async (tx) => {
    const updated = await tx
      .update(users)
      .set({ status: 'suspended' })
      .where(and(eq(users.id, userId), eq(users.status, 'active')))
      .returning({ id: users.id, role: users.role })

    const target = updated[0]

    const revoked = await tx
      .delete(authSessions)
      .where(eq(authSessions.userId, userId))
      .returning({ id: authSessions.id })

    await recordAuditEvent(tx, {
      actor: systemActor('admin'),
      action: AuditActions.accountSuspended,
      entityType: 'user',
      entityId: userId,
      summary: reason,
      changes: { revokedSessions: revoked.length },
    })

    return target === undefined ? 0 : revoked.length
  })
}
