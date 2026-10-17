import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Database } from '../../src/db/client.js'
import { findings } from '../../src/db/schema/findings.js'
import { parcelLineage } from '../../src/db/schema/lineage.js'
import { parcels } from '../../src/db/schema/parcels.js'
import {
  seedSyntheticData,
  SUPERSEDED_FINDING_FRAGMENT,
  SYNTHETIC_FINDING_EXPLANATION,
  SYNTHETIC_FINDING_ID,
} from '../../src/db/seed.js'
import { areasEqual, compareAreas, sumAreas } from '../../src/lib/rational.js'
import {
  closeTestDatabase,
  firstOrThrow,
  initializeTestDatabase,
} from '../helpers/database.js'

/** The seed only ever writes to this mouza, so it is safe to count on. */
const SEED_MOUZA = 'শালবন'

let database: Database

beforeAll(async () => {
  database = await initializeTestDatabase()
})

afterAll(async () => {
  await closeTestDatabase()
})

async function selectFinding(
  id: string,
): Promise<typeof findings.$inferSelect | undefined> {
  const rows = await database.orm
    .select()
    .from(findings)
    .where(eq(findings.id, id))
  return rows[0]
}

describe('seedSyntheticData', () => {
  it('refuses to run against a production database', async () => {
    await expect(
      seedSyntheticData(database, { nodeEnv: 'production' }),
    ).rejects.toThrow(/production/i)
  })

  it('is idempotent: once repairs are applied, re-running changes nothing', async () => {
    // Warm-up absorbs a possible one-time repair of a superseded fixture so the
    // two runs compared below are both steady-state.
    await seedSyntheticData(database, { nodeEnv: 'test' })

    const first = await seedSyntheticData(database, { nodeEnv: 'test' })
    const second = await seedSyntheticData(database, { nodeEnv: 'test' })

    expect(second).toEqual(first)
    expect(second.repairedFindings).toBe(0)
    expect(second.parcels).toBe(5)

    const seededParcels = await database.orm
      .select()
      .from(parcels)
      .where(eq(parcels.mouza, SEED_MOUZA))
    expect(seededParcels).toHaveLength(5)

    const links = await database.orm.select().from(parcelLineage)
    expect(links.length).toBeGreaterThanOrEqual(first.lineageLinks)
  })

  it('repairs the superseded synthetic finding and preserves unrelated rows', async () => {
    await seedSyntheticData(database, { nodeEnv: 'test' })

    // Recreate the stale state on the fixed synthetic identifier.
    await database.orm
      .update(findings)
      .set({ explanation: `পুরনো লেখা: ${SUPERSEDED_FINDING_FRAGMENT}` })
      .where(eq(findings.id, SYNTHETIC_FINDING_ID))

    // An unrelated synthetic row that the repair must not touch.
    const unrelatedParcel = await firstOrThrow(
      await database.orm
        .insert(parcels)
        .values({
          survey: 'CS',
          origin: 'synthetic_demo',
          district: `RepairDistrict-${randomUUID()}`,
          upazila: 'RepairUpazila',
          mouza: 'RepairMouza',
          jlNumber: '43',
          khatianNumber: '1',
          areaDecimal: '1.0000',
        })
        .returning(),
    )
    const unrelated = await firstOrThrow(
      await database.orm
        .insert(findings)
        .values({
          parcelId: unrelatedParcel.id,
          kind: 'other',
          title: 'Unrelated synthetic finding',
          explanation: 'Untouched by the repair.',
        })
        .returning(),
    )

    const repaired = await seedSyntheticData(database, { nodeEnv: 'test' })
    expect(repaired.repairedFindings).toBe(1)

    const fixed = await selectFinding(SYNTHETIC_FINDING_ID)
    expect(fixed?.explanation).toBe(SYNTHETIC_FINDING_EXPLANATION)

    const unrelatedAfter = await selectFinding(unrelated.id)
    expect(unrelatedAfter?.explanation).toBe('Untouched by the repair.')
    expect(unrelatedAfter?.title).toBe('Unrelated synthetic finding')

    // A second run performs no repair and leaves the corrected text in place.
    const again = await seedSyntheticData(database, { nodeEnv: 'test' })
    expect(again.repairedFindings).toBe(0)

    const fixedAgain = await selectFinding(SYNTHETIC_FINDING_ID)
    expect(fixedAgain?.explanation).toBe(SYNTHETIC_FINDING_EXPLANATION)
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
