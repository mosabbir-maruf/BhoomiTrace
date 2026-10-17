import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Database } from '../../src/db/client.js'
import { parcelLineage } from '../../src/db/schema/lineage.js'
import { parcels } from '../../src/db/schema/parcels.js'
import { seedSyntheticData } from '../../src/db/seed.js'
import { areasEqual, compareAreas, sumAreas } from '../../src/lib/rational.js'
import { closeTestDatabase, initializeTestDatabase } from '../helpers/database.js'

/** The seed only ever writes to this mouza, so it is safe to count on. */
const SEED_MOUZA = 'শালবন'

let database: Database

beforeAll(async () => {
  database = await initializeTestDatabase()
})

afterAll(async () => {
  await closeTestDatabase()
})

describe('seedSyntheticData', () => {
  it('refuses to run against a production database', async () => {
    await expect(
      seedSyntheticData(database, { nodeEnv: 'production' }),
    ).rejects.toThrow(/production/i)
  })

  it('is idempotent: running twice changes nothing', async () => {
    const first = await seedSyntheticData(database, { nodeEnv: 'test' })
    const second = await seedSyntheticData(database, { nodeEnv: 'test' })

    expect(second).toEqual(first)
    expect(first.parcels).toBe(5)

    const seededParcels = await database.orm
      .select()
      .from(parcels)
      .where(eq(parcels.mouza, SEED_MOUZA))
    expect(seededParcels).toHaveLength(5)

    const links = await database.orm.select().from(parcelLineage)
    expect(links.length).toBeGreaterThanOrEqual(first.lineageLinks)
  })

  it('reconciles the synthetic split exactly', async () => {
    await seedSyntheticData(database, { nodeEnv: 'test' })

    const seededParcels = await database.orm
      .select()
      .from(parcels)
      .where(eq(parcels.mouza, SEED_MOUZA))

    const rs104 = seededParcels.find((parcel) => parcel.khatianNumber === '104')
    const bs208 = seededParcels.find((parcel) => parcel.khatianNumber === '208')
    const bs209 = seededParcels.find((parcel) => parcel.khatianNumber === '209')

    expect(rs104).toBeDefined()
    expect(bs208).toBeDefined()
    expect(bs209).toBeDefined()

    const splitTotal = sumAreas([
      bs208?.areaDecimal ?? '0',
      bs209?.areaDecimal ?? '0',
    ])

    // 75 + 50 decimals equals the 125 decimals recorded in the RS khatian.
    expect(areasEqual(splitTotal, rs104?.areaDecimal ?? '0')).toBe(true)
    expect(compareAreas(splitTotal, '125.0000')).toBe(0)
  })

  it('records unevidenced lineage as illustrative, never as confirmed', async () => {
    await seedSyntheticData(database, { nodeEnv: 'test' })

    const links = await database.orm.select().from(parcelLineage)
    const unverified = links.filter((link) => link.certainty === 'illustrative')

    expect(unverified.length).toBeGreaterThan(0)
    for (const link of unverified) {
      expect(link.certainty).not.toBe('confirmed')
    }
  })
})
