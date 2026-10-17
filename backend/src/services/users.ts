import { eq } from 'drizzle-orm'

import type { Database } from '../db/client.js'
import { users } from '../db/schema/users.js'
import { NotFoundError } from '../lib/errors.js'

/**
 * Account lookups shared by the services that accept an account identifier.
 *
 * Two services can be told "file this for that account" — parcels and source
 * documents — and both must answer the same way when the account does not
 * exist. Relying on the foreign key instead would report a missing account as a
 * reference conflict, which describes a dependency problem rather than a bad
 * identifier.
 */
export async function requireExistingUser(
  database: Database,
  userId: string,
): Promise<void> {
  const rows = await database.orm
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (rows.length === 0) {
    throw new NotFoundError('No account exists with that owner identifier.')
  }
}
