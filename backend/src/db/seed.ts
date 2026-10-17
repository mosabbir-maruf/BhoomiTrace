import { and, eq, sql } from 'drizzle-orm'

import type { Database } from './client.js'
import { auditEvents } from './schema/audit.js'
import { sourceDocuments } from './schema/documents.js'
import { extractions } from './schema/extractions.js'
import { findings } from './schema/findings.js'
import { parcelLineage } from './schema/lineage.js'
import { parcelDags, parcels } from './schema/parcels.js'

/**
 * Synthetic seed data for local development.
 *
 * Every identifier, name, and number below is invented for interface review.
 * Nothing here refers to a real person, parcel, or government record, and no
 * value is presented as an OCR or model output. Fixed UUIDs make the seed
 * idempotent: running it twice changes nothing.
 *
 * The suite also performs one narrowly scoped repair (see
 * `SUPERSEDED_FINDING_FRAGMENT`) so that a database seeded before a fixture
 * wording correction converges without resetting the volume.
 */

export interface SeedOptions {
  /** The seed refuses to run against a production database. */
  nodeEnv: string
}

export interface SeedSummary {
  parcels: number
  parcelDags: number
  lineageLinks: number
  sourceDocuments: number
  extractions: number
  findings: number
  auditEvents: number
  /**
   * Rows corrected by the superseded-fixture repair during this run. Zero on a
   * database that is already up to date, which is what makes a re-run a no-op.
   */
  repairedFindings: number
}

const PARCEL = {
  cs42: 'a1000000-0000-4000-8000-000000000001',
  sa67: 'a1000000-0000-4000-8000-000000000002',
  rs104: 'a1000000-0000-4000-8000-000000000003',
  bs208: 'a1000000-0000-4000-8000-000000000004',
  bs209: 'a1000000-0000-4000-8000-000000000005',
} as const

/** The single synthetic finding, addressed by its fixed identifier. */
export const SYNTHETIC_FINDING_ID = 'd1000000-0000-4000-8000-000000000001'

/**
 * Sentence that only ever appeared in the superseded revision of this fixture.
 * It is used both to recognise a stale row and, in tests, to recreate one.
 */
export const SUPERSEDED_FINDING_FRAGMENT = 'দুই খতিয়ানের যোগফল ১২৫ নয়'

export const SYNTHETIC_FINDING_EXPLANATION =
  'আরএস খতিয়ান ১০৪-এ ১২৫.০০০০ দশমিক এবং বিএস খতিয়ান ২০৮-এ ৭৫.০০০০ দশমিক লেখা আছে। বিএস খতিয়ান ২০৯-এ ৫০.০০০০ দশমিক থাকলেও সেই সংযোগ নমুনায় প্রমাণিত নয়, তাই ১২৫ দশমিকের বাকি অংশ কোথায় গেল তা মিলিয়ে দেখা দরকার।'

const DAG = {
  cs42: 'a2000000-0000-4000-8000-000000000001',
  sa67: 'a2000000-0000-4000-8000-000000000002',
  rs104: 'a2000000-0000-4000-8000-000000000003',
  bs208: 'a2000000-0000-4000-8000-000000000004',
  bs209: 'a2000000-0000-4000-8000-000000000005',
} as const

const LINEAGE = {
  csToSa: 'a3000000-0000-4000-8000-000000000001',
  saToRs: 'a3000000-0000-4000-8000-000000000002',
  rsToBs208: 'a3000000-0000-4000-8000-000000000003',
  rsToBs209: 'a3000000-0000-4000-8000-000000000004',
} as const

const SOURCE_DOCUMENT_ID = 'b1000000-0000-4000-8000-000000000001'

const BASE_LOCATION = {
  district: 'টাঙ্গাইল',
  upazila: 'মির্জাপুর',
  mouza: 'শালবন',
  jlNumber: '43',
} as const

export async function seedSyntheticData(
  database: Database,
  options: SeedOptions,
): Promise<SeedSummary> {
  if (options.nodeEnv === 'production') {
    throw new Error('Refusing to seed synthetic data into a production database.')
  }

  return database.orm.transaction(async (tx) => {
    await tx
      .insert(parcels)
      .values([
        {
          id: PARCEL.cs42,
          ...BASE_LOCATION,
          survey: 'CS',
          khatianNumber: '42',
          areaDecimal: '120.0000',
          shareNumerator: 1,
          shareDenominator: 2,
        },
        {
          id: PARCEL.sa67,
          ...BASE_LOCATION,
          survey: 'SA',
          khatianNumber: '67',
          areaDecimal: '125.0000',
          shareNumerator: 1,
          shareDenominator: 2,
        },
        {
          id: PARCEL.rs104,
          ...BASE_LOCATION,
          survey: 'RS',
          khatianNumber: '104',
          areaDecimal: '125.0000',
          shareNumerator: 1,
          shareDenominator: 2,
        },
        {
          id: PARCEL.bs208,
          ...BASE_LOCATION,
          survey: 'BS',
          khatianNumber: '208',
          areaDecimal: '75.0000',
          shareNumerator: 1,
          shareDenominator: 2,
        },
        {
          id: PARCEL.bs209,
          ...BASE_LOCATION,
          survey: 'BS',
          khatianNumber: '209',
          areaDecimal: '50.0000',
          shareNumerator: 1,
          shareDenominator: 3,
        },
      ])
      .onConflictDoNothing()

    await tx
      .insert(parcelDags)
      .values([
        { id: DAG.cs42, parcelId: PARCEL.cs42, dagNumber: '128' },
        { id: DAG.sa67, parcelId: PARCEL.sa67, dagNumber: '128' },
        { id: DAG.rs104, parcelId: PARCEL.rs104, dagNumber: '341' },
        { id: DAG.bs208, parcelId: PARCEL.bs208, dagNumber: '712' },
        { id: DAG.bs209, parcelId: PARCEL.bs209, dagNumber: '713' },
      ])
      .onConflictDoNothing()

    await tx
      .insert(parcelLineage)
      .values([
        {
          id: LINEAGE.csToSa,
          fromParcelId: PARCEL.cs42,
          toParcelId: PARCEL.sa67,
          relation: 'continued',
          certainty: 'confirmed',
          evidenceReference: 'CS পৃষ্ঠা ০১৭ / SA পৃষ্ঠা ০২৩, তফসিল ঘর ১',
          note: 'একই দাগ নম্বর ১২৮; রেকর্ডভুক্ত নাম অপরিবর্তিত।',
        },
        {
          id: LINEAGE.saToRs,
          fromParcelId: PARCEL.sa67,
          toParcelId: PARCEL.rs104,
          relation: 'renumbered',
          certainty: 'illustrative',
          evidenceReference: 'SA পৃষ্ঠা ০২৩ / RS পৃষ্ঠা ০৩৪',
          note: 'আরএস জরিপে দাগ ৩৪১ হিসেবে দেখানো; সংযোগের নথি নমুনায় নেই।',
        },
        {
          id: LINEAGE.rsToBs208,
          fromParcelId: PARCEL.rs104,
          toParcelId: PARCEL.bs208,
          relation: 'split',
          certainty: 'confirmed',
          evidenceReference: 'RS পৃষ্ঠা ০৩৪ / BS পৃষ্ঠা ০৪১',
          note: '১২৫ দশমিকের মধ্যে ৭৫ দশমিক এই খতিয়ানে দেখানো হয়েছে।',
        },
        {
          id: LINEAGE.rsToBs209,
          fromParcelId: PARCEL.rs104,
          toParcelId: PARCEL.bs209,
          relation: 'split',
          certainty: 'illustrative',
          evidenceReference: 'BS পৃষ্ঠা ০৪২ (নমুনায় আংশিক)',
          note: 'বাকি ৫০ দশমিক সম্ভবত এই খতিয়ানে; মিলিয়ে দেখা হয়নি।',
        },
      ])
      .onConflictDoNothing()

    await tx
      .insert(sourceDocuments)
      .values([
        {
          id: SOURCE_DOCUMENT_ID,
          title: 'শালবন মৌজা, আরএস খতিয়ান ১০৪ (নমুনা নথি)',
          kind: 'synthetic_demo',
          reference: 'DEMO/RS/শালবন/034',
          pageCount: 1,
          status: 'submitted',
        },
      ])
      .onConflictDoNothing()

    await tx
      .insert(extractions)
      .values([
        {
          id: 'c1000000-0000-4000-8000-000000000001',
          parcelId: PARCEL.rs104,
          sourceDocumentId: SOURCE_DOCUMENT_ID,
          field: 'khatian',
          recordedValue: '104',
          pageReference: 'শিরোনাম, ঘর ১',
        },
        {
          id: 'c1000000-0000-4000-8000-000000000002',
          parcelId: PARCEL.rs104,
          sourceDocumentId: SOURCE_DOCUMENT_ID,
          field: 'mouza',
          recordedValue: 'শালবন',
          pageReference: 'শিরোনাম, ঘর ২',
        },
        {
          id: 'c1000000-0000-4000-8000-000000000003',
          parcelId: PARCEL.rs104,
          sourceDocumentId: SOURCE_DOCUMENT_ID,
          field: 'dag',
          recordedValue: '341',
          pageReference: 'তফসিল, ঘর ১',
        },
        {
          id: 'c1000000-0000-4000-8000-000000000004',
          parcelId: PARCEL.rs104,
          sourceDocumentId: SOURCE_DOCUMENT_ID,
          field: 'area',
          recordedValue: '125.0000',
          pageReference: 'তফসিল, ঘর ৩',
        },
        {
          id: 'c1000000-0000-4000-8000-000000000005',
          parcelId: PARCEL.rs104,
          sourceDocumentId: SOURCE_DOCUMENT_ID,
          field: 'share',
          recordedValue: '1/2',
          pageReference: 'স্বত্বের বিবরণ, ঘর ২',
        },
        {
          // Deliberately unreadable: no reviewed value, no invented confidence.
          id: 'c1000000-0000-4000-8000-000000000006',
          parcelId: PARCEL.bs208,
          field: 'share',
          recordedValue: 'অস্পষ্ট',
          reviewStatus: 'unclear',
          isUnclear: true,
          pageReference: 'স্বত্বের বিবরণ, ঘর ২',
        },
      ])
      .onConflictDoNothing()

    await tx
      .insert(findings)
      .values([
        {
          id: SYNTHETIC_FINDING_ID,
          parcelId: PARCEL.rs104,
          relatedParcelId: PARCEL.bs208,
          kind: 'area_mismatch',
          severity: 'medium',
          status: 'open',
          title: 'আরএস ১০৪ ও বিএস ২০৮-এর জমির পরিমাণ মিলছে না',
          explanation: SYNTHETIC_FINDING_EXPLANATION,
          evidenceReference: 'RS পৃষ্ঠা ০৩৪ / BS পৃষ্ঠা ০৪১',
        },
      ])
      .onConflictDoNothing()

    // Narrow, idempotent repair for databases seeded before the wording of this
    // fixture was corrected. It is scoped to the single fixed synthetic id *and*
    // to rows that still contain the superseded sentence, so it can never
    // overwrite a row that has since been edited, and it becomes a no-op after
    // the first successful run.
    const repaired = await tx
      .update(findings)
      .set({ explanation: SYNTHETIC_FINDING_EXPLANATION })
      .where(
        and(
          eq(findings.id, SYNTHETIC_FINDING_ID),
          sql`${findings.explanation} like ${`%${SUPERSEDED_FINDING_FRAGMENT}%`}`,
        ),
      )
      .returning({ id: findings.id })

    await tx
      .insert(auditEvents)
      .values([
        {
          id: 'e1000000-0000-4000-8000-000000000001',
          action: 'seed.synthetic_dataset',
          entityType: 'system',
          summary: 'Loaded the synthetic demo dataset (Phase 1 seed).',
        },
      ])
      .onConflictDoNothing()

    return {
      parcels: 5,
      parcelDags: 5,
      lineageLinks: 4,
      sourceDocuments: 1,
      extractions: 6,
      findings: 1,
      auditEvents: 1,
      repairedFindings: repaired.length,
    } satisfies SeedSummary
  })
}
