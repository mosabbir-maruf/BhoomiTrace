import { and, asc, desc, eq, inArray } from 'drizzle-orm'

import type { Database } from '../db/client.js'
import type {
  ExtractionField,
  FindingKind,
  FindingSeverity,
} from '../db/schema/enums.js'
import { extractions, type Extraction } from '../db/schema/extractions.js'
import { findings, type Finding } from '../db/schema/findings.js'
import { parcelLineage, type ParcelLineage } from '../db/schema/lineage.js'
import { parcelDags, parcels, type Parcel } from '../db/schema/parcels.js'
import type { RecordReference } from '../db/schema/types.js'
import {
  areasEqual,
  compareAreas,
  formatShare,
  parseArea,
  parseShare,
  sharesEqual,
} from '../lib/rational.js'
import { describeLineageArithmetic } from '../services/lineage.js'

/**
 * Deterministic validation and reconciliation.
 *
 * Every rule has a stable code, states what it compared, what it expected, and
 * what it found, and returns one of four outcomes. The rule set is versioned
 * (`VALIDATION_RULES_VERSION`) so a stored report can be read against the rules
 * that produced it.
 *
 * Two principles are load-bearing:
 *
 * 1. **A mismatch is a finding, not a verdict.** Areas that do not add up, a
 *    share that cannot be read, a lineage link without evidence — each produces
 *    an explanation a person can act on. Nothing here concludes fraud, decides
 *    ownership, or marks a record legally approved.
 * 2. **Exact arithmetic only.** Areas are compared as scaled integers and shares
 *    as exact rationals. A comparison is never made in floating point, because a
 *    binary rounding error must not be able to invent or hide a discrepancy.
 */

export type RuleOutcome = 'pass' | 'fail' | 'needs_review' | 'not_applicable'

export interface RuleResult {
  ruleCode: string
  severity: FindingSeverity
  outcome: RuleOutcome
  title: string
  explanation: string
  observedValue: string | null
  expectedValue: string | null
  evidenceReference: string | null
  recordReferences: RecordReference[]
  /**
   * The kind of finding a non-pass outcome raises, when the outcome warrants
   * one. A rule with no kind is reported in a checklist but never creates a row
   * in `findings`.
   */
  findingKind: FindingKind | null
}

const BANGLA_DIGITS: Readonly<Record<string, string>> = {
  '০': '0',
  '১': '1',
  '২': '2',
  '৩': '3',
  '৪': '4',
  '৫': '5',
  '৬': '6',
  '৭': '7',
  '৮': '8',
  '৯': '9',
}

/**
 * Converts Bengali digits to ASCII.
 *
 * Land records in this domain are commonly written in Bengali, so a value such
 * as `১২৫.০` is a perfectly ordinary area and must not be treated as malformed.
 * This is a faithful transliteration of the digits, not a guess at the number:
 * a value that is still unparseable afterwards is genuinely unreadable.
 */
export function normaliseDigits(text: string): string {
  return text.replace(/[০-৯]/g, (digit) => BANGLA_DIGITS[digit] ?? digit)
}

/**
 * Reads a decimal area out of free text.
 *
 * Returns `null` when the text is not an exact area. Callers treat `null` as
 * "unreadable" and report `needs_review`, never as a mismatch — an unparseable
 * value is unknown, not wrong.
 */
export function tryParseArea(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const candidate = normaliseDigits(raw).trim()
  try {
    return parseArea(candidate).toString()
  } catch {
    return null
  }
}

/**
 * Reads an ownership share out of free text.
 *
 * Free text is normalised first, because a real record reads `১/২` or `1/2`,
 * while a smudged one reads `১/২ (অস্পষ্ট)`. Only a value that is *entirely* a
 * share is accepted; anything else is unreadable and reported as such rather
 * than salvaged into a number the record does not support.
 */
export function tryParseShare(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const candidate = normaliseDigits(raw).trim()
  try {
    return formatShare(parseShare(candidate))
  } catch {
    return null
  }
}

/** Everything a rule needs, loaded once per parcel. */
export interface ReconciliationContext {
  parcel: Parcel
  dagNumbers: string[]
  extractionRows: Extraction[]
  outgoingLineage: ParcelLineage[]
  incomingLineage: ParcelLineage[]
  openFindings: Finding[]
}

/** Loads the parcel and everything the rules inspect. */
export async function loadReconciliationContext(
  database: Database,
  parcelId: string,
): Promise<ReconciliationContext | null> {
  const parcelRows = await database.orm
    .select()
    .from(parcels)
    .where(eq(parcels.id, parcelId))
    .limit(1)

  const parcel = parcelRows[0]
  if (parcel === undefined) return null

  const [dagRows, extractionRows, outgoing, incoming, openFindingRows] =
    await Promise.all([
      database.orm
        .select({ dagNumber: parcelDags.dagNumber })
        .from(parcelDags)
        .where(eq(parcelDags.parcelId, parcelId))
        .orderBy(asc(parcelDags.dagNumber)),
      database.orm
        .select()
        .from(extractions)
        .where(eq(extractions.parcelId, parcelId))
        .orderBy(asc(extractions.createdAt)),
      database.orm
        .select()
        .from(parcelLineage)
        .where(eq(parcelLineage.fromParcelId, parcelId)),
      database.orm
        .select()
        .from(parcelLineage)
        .where(eq(parcelLineage.toParcelId, parcelId)),
      database.orm
        .select()
        .from(findings)
        .where(
          and(
            eq(findings.parcelId, parcelId),
            inArray(findings.status, ['open', 'under_review']),
          ),
        )
        .orderBy(desc(findings.createdAt)),
    ])

  return {
    parcel,
    dagNumbers: dagRows.map((row) => row.dagNumber),
    extractionRows,
    outgoingLineage: outgoing,
    incomingLineage: incoming,
    openFindings: openFindingRows,
  }
}

/** A rule: a pure function of the loaded context. */
export type ReconciliationRule = (
  context: ReconciliationContext,
) => RuleResult | Promise<RuleResult>

function pass(
  ruleCode: string,
  severity: FindingSeverity,
  partial: Omit<RuleResult, 'ruleCode' | 'severity' | 'outcome' | 'findingKind'>,
): RuleResult {
  return {
    ruleCode,
    severity,
    outcome: 'pass',
    findingKind: null,
    ...partial,
  }
}

function problem(
  ruleCode: string,
  severity: FindingSeverity,
  outcome: Exclude<RuleOutcome, 'pass' | 'not_applicable'>,
  findingKind: FindingKind | null,
  partial: Omit<
    RuleResult,
    'ruleCode' | 'severity' | 'outcome' | 'findingKind'
  >,
): RuleResult {
  return { ruleCode, severity, outcome, findingKind, ...partial }
}

function notApplicable(
  ruleCode: string,
  severity: FindingSeverity,
  title: string,
  explanation: string,
): RuleResult {
  return {
    ruleCode,
    severity,
    outcome: 'not_applicable',
    title,
    explanation,
    observedValue: null,
    expectedValue: null,
    evidenceReference: null,
    recordReferences: [],
    findingKind: null,
  }
}

/* -------------------------------------------------------------------------- */
/* Record rules                                                                */
/* -------------------------------------------------------------------------- */

/** Identity fields a usable record must carry. */
const parcelIdentityRule: ReconciliationRule = (context) => {
  const ruleCode = 'RECORD_REQUIRED_FIELDS_PRESENT'
  const missing: string[] = []
  const parcel = context.parcel

  if (parcel.khatianNumber.trim().length === 0) missing.push('khatianNumber')
  if (parcel.mouza.trim().length === 0) missing.push('mouza')
  if (parcel.jlNumber.trim().length === 0) missing.push('jlNumber')
  if (parcel.upazila.trim().length === 0) missing.push('upazila')
  if (parcel.district.trim().length === 0) missing.push('district')

  if (missing.length === 0) {
    return pass(ruleCode, 'high', {
      title: 'Required record fields are present',
      explanation:
        'Every identifying field the platform indexes is populated, so the record can be located and compared.',
      observedValue: `survey=${parcel.survey}, khatian=${parcel.khatianNumber}`,
      expectedValue: 'all identifying fields populated',
      evidenceReference: null,
      recordReferences: [{ entityType: 'parcel', entityId: parcel.id }],
    })
  }

  return problem(ruleCode, 'high', 'fail', 'other', {
    title: 'Required record fields are missing',
    explanation: `The record is missing: ${missing.join(', ')}. A record without these cannot be matched against another survey.`,
    observedValue: `missing ${missing.length} field(s)`,
    expectedValue: 'all identifying fields populated',
    evidenceReference: null,
    recordReferences: [{ entityType: 'parcel', entityId: parcel.id }],
  })
}

/** A recorded area must be strictly positive. */
const parcelAreaPositiveRule: ReconciliationRule = (context) => {
  const ruleCode = 'RECORD_AREA_POSITIVE'
  const observed = tryParseArea(context.parcel.areaDecimal)

  if (observed === null) {
    return problem(ruleCode, 'high', 'needs_review', 'other', {
      title: 'Recorded area could not be read as a number',
      explanation: `The recorded area "${context.parcel.areaDecimal}" is not a value the platform can compare exactly. It is unknown rather than wrong.`,
      observedValue: context.parcel.areaDecimal,
      expectedValue: 'a decimal area greater than 0',
      evidenceReference: null,
      recordReferences: [{ entityType: 'parcel', entityId: context.parcel.id }],
    })
  }

  if (compareAreas(context.parcel.areaDecimal, '0') <= 0) {
    return problem(ruleCode, 'high', 'fail', 'other', {
      title: 'Recorded area is not positive',
      explanation:
        'A parcel with a zero or negative recorded area cannot take part in split or merge arithmetic.',
      observedValue: context.parcel.areaDecimal,
      expectedValue: 'a decimal area greater than 0',
      evidenceReference: null,
      recordReferences: [{ entityType: 'parcel', entityId: context.parcel.id }],
    })
  }

  return pass(ruleCode, 'high', {
    title: 'Recorded area is a positive number',
    explanation: `The recorded area ${context.parcel.areaDecimal} is a positive decimal and can be compared exactly.`,
    observedValue: context.parcel.areaDecimal,
    expectedValue: 'a decimal area greater than 0',
    evidenceReference: null,
    recordReferences: [{ entityType: 'parcel', entityId: context.parcel.id }],
  })
}

/** A khatian number is a number, in either script. */
const parcelKhatianShapeRule: ReconciliationRule = (context) => {
  const ruleCode = 'RECORD_KHATIAN_SHAPE'
  const normalised = normaliseDigits(context.parcel.khatianNumber).trim()

  if (/^\d+$/.test(normalised)) {
    return pass(ruleCode, 'low', {
      title: 'Khatian number is well formed',
      explanation: `The khatian number reads as digits ("${context.parcel.khatianNumber}").`,
      observedValue: context.parcel.khatianNumber,
      expectedValue: 'digits, in Bengali or ASCII',
      evidenceReference: null,
      recordReferences: [{ entityType: 'parcel', entityId: context.parcel.id }],
    })
  }

  return problem(ruleCode, 'low', 'needs_review', 'other', {
    title: 'Khatian number is not purely numeric',
    explanation: `"${context.parcel.khatianNumber}" contains characters outside digits. Some records do carry suffixes, so this needs a human look rather than an automatic comparison.`,
    observedValue: context.parcel.khatianNumber,
    expectedValue: 'digits, in Bengali or ASCII',
    evidenceReference: null,
    recordReferences: [{ entityType: 'parcel', entityId: context.parcel.id }],
  })
}

/** A share denominator must be positive, and the share must not exceed a whole. */
const shareValidityRule: ReconciliationRule = (context) => {
  const ruleCode = 'RECORD_SHARE_VALID'
  const parcel = context.parcel

  if (parcel.shareDenominator <= 0) {
    return problem(ruleCode, 'high', 'fail', 'share_mismatch', {
      title: 'Share denominator is not positive',
      explanation:
        'A share with a zero or negative denominator has no meaning, so no arithmetic on it can be trusted.',
      observedValue: `${parcel.shareNumerator}/${parcel.shareDenominator}`,
      expectedValue: 'a denominator greater than 0',
      evidenceReference: null,
      recordReferences: [{ entityType: 'parcel', entityId: parcel.id }],
    })
  }

  const share = formatShare({
    numerator: BigInt(parcel.shareNumerator),
    denominator: BigInt(parcel.shareDenominator),
  })

  if (parcel.shareNumerator > parcel.shareDenominator) {
    return problem(ruleCode, 'medium', 'needs_review', 'share_mismatch', {
      title: 'Recorded share is larger than one whole',
      explanation: `The recorded share ${share} is greater than 1. That can be legitimate in some records, but it must be confirmed rather than assumed.`,
      observedValue: share,
      expectedValue: 'a share within 0 and 1',
      evidenceReference: null,
      recordReferences: [{ entityType: 'parcel', entityId: parcel.id }],
    })
  }

  return pass(ruleCode, 'high', {
    title: 'Recorded share is well formed',
    explanation: `The recorded share ${share} has a positive denominator and does not exceed one whole.`,
    observedValue: share,
    expectedValue: 'a share within 0 and 1',
    evidenceReference: null,
    recordReferences: [{ entityType: 'parcel', entityId: parcel.id }],
  })
}

/** At least one extracted value must be backed by a source document. */
const evidencePresentRule: ReconciliationRule = (context) => {
  const ruleCode = 'EVIDENCE_ANY_SOURCE_DOCUMENT'
  const linked = context.extractionRows.filter(
    (row) => row.sourceDocumentId !== null,
  )

  if (linked.length > 0) {
    return pass(ruleCode, 'medium', {
      title: 'Readings are backed by a source document',
      explanation: `${linked.length} extracted value(s) cite a source document, so the reading can be checked against the record itself.`,
      observedValue: `${linked.length} linked extraction(s)`,
      expectedValue: 'at least one linked extraction',
      evidenceReference: null,
      recordReferences: [{ entityType: 'parcel', entityId: context.parcel.id }],
    })
  }

  if (context.extractionRows.length === 0) {
    return notApplicable(
      ruleCode,
      'medium',
      'No extracted values to evidence',
      'This record has no extracted values yet, so there is nothing to check against a source document.',
    )
  }

  return problem(ruleCode, 'medium', 'needs_review', 'unclear_reading', {
    title: 'No reading is backed by a source document',
    explanation: `${context.extractionRows.length} extracted value(s) exist and none cites a source document. Manual entry is legitimate, but nothing here can be checked against a record.`,
    observedValue: '0 linked extractions',
    expectedValue: 'at least one linked extraction',
    evidenceReference: null,
    recordReferences: [{ entityType: 'parcel', entityId: context.parcel.id }],
  })
}

/** Corrected or verified values must still carry their original reading. */
const extractionReviewStateRule: ReconciliationRule = (context) => {
  const ruleCode = 'EXTRACTION_REVIEW_STATE'
  const pending = context.extractionRows.filter(
    (row) => row.reviewStatus === 'pending',
  )
  const unclear = context.extractionRows.filter((row) => row.isUnclear)

  if (context.extractionRows.length === 0) {
    return notApplicable(
      ruleCode,
      'medium',
      'No extracted values to review',
      'This record has no extracted values, so there is nothing waiting on a reviewer.',
    )
  }

  if (pending.length === 0 && unclear.length === 0) {
    return pass(ruleCode, 'medium', {
      title: 'Every extracted value has been decided',
      explanation: `${context.extractionRows.length} extracted value(s) are confirmed or corrected, and none is unreadable.`,
      observedValue: `${context.extractionRows.length} decided, 0 pending, 0 unclear`,
      expectedValue: '0 pending and 0 unclear',
      evidenceReference: null,
      recordReferences: [{ entityType: 'parcel', entityId: context.parcel.id }],
    })
  }

  const parts: string[] = []
  if (pending.length > 0) parts.push(`${pending.length} awaiting review`)
  if (unclear.length > 0) parts.push(`${unclear.length} unreadable`)

  return problem(ruleCode, 'high', 'needs_review', 'unclear_reading', {
    title: 'Extracted values still need a reviewer',
    explanation: `${parts.join(', ')}. Until a reviewer decides, these values cannot be relied on.`,
    observedValue: `${pending.length} pending, ${unclear.length} unclear`,
    expectedValue: '0 pending and 0 unclear',
    evidenceReference: null,
    recordReferences: [
      { entityType: 'parcel', entityId: context.parcel.id },
      ...context.extractionRows
        .filter((row) => row.reviewStatus === 'pending' || row.isUnclear)
        .slice(0, 10)
        .map((row) => ({
          entityType: 'extraction',
          entityId: row.id,
          label: row.field,
        })),
    ],
  })
}

/* -------------------------------------------------------------------------- */
/* Source-versus-record comparison rules                                       */
/* -------------------------------------------------------------------------- */

/** The value a reviewer accepted, falling back to what was read. */
function effectiveValue(row: Extraction): string {
  return row.reviewedValue ?? row.recordedValue
}

/**
 * What comparing one reading with the record concluded.
 *
 * The third case is the important one. A value the platform cannot parse is not
 * a value that disagrees with the record — it is a value nobody has read yet, and
 * saying otherwise would assert a mismatch the data does not support.
 */
type ComparisonVerdict = 'agree' | 'disagree' | 'unreadable'

interface FieldComparison {
  ruleCode: string
  field: ExtractionField
  title: string
  findingKind: FindingKind
  expected: string
  /** Compares one reading with the record's value. */
  compare: (observed: string, expected: string) => ComparisonVerdict
  severity: FindingSeverity
}

const FIELD_COMPARISONS: readonly FieldComparison[] = [
  {
    ruleCode: 'EXTRACTION_AREA_MATCHES_RECORD',
    field: 'area',
    title: 'Extracted area agrees with the record',
    findingKind: 'area_mismatch',
    expected: 'parcel recorded area',
    compare: (observed, expected) => {
      const left = tryParseArea(observed)
      const right = tryParseArea(expected)
      if (left === null || right === null) return 'unreadable'
      return areasEqual(left, right) ? 'agree' : 'disagree'
    },
    severity: 'high',
  },
  {
    ruleCode: 'EXTRACTION_SHARE_MATCHES_RECORD',
    field: 'share',
    title: 'Extracted share agrees with the record',
    findingKind: 'share_mismatch',
    expected: 'parcel recorded share',
    compare: (observed, expected) => {
      const left = tryParseShare(observed)
      const right = tryParseShare(expected)
      if (left === null || right === null) return 'unreadable'
      return sharesEqual(left, right) ? 'agree' : 'disagree'
    },
    severity: 'high',
  },
  {
    ruleCode: 'EXTRACTION_KHATIAN_MATCHES_RECORD',
    field: 'khatian',
    title: 'Extracted khatian number agrees with the record',
    findingKind: 'khatian_mismatch',
    expected: 'parcel khatian number',
    compare: (observed, expected) =>
      normaliseDigits(observed).trim() === normaliseDigits(expected).trim()
        ? 'agree'
        : 'disagree',
    severity: 'medium',
  },
  {
    ruleCode: 'EXTRACTION_MOUZA_MATCHES_RECORD',
    field: 'mouza',
    title: 'Extracted mouza agrees with the record',
    findingKind: 'mouza_mismatch',
    expected: 'parcel mouza',
    compare: (observed, expected) =>
      observed.trim().normalize('NFC') === expected.trim().normalize('NFC')
        ? 'agree'
        : 'disagree',
    severity: 'medium',
  },
]

/**
 * Builds a comparison rule for one field.
 *
 * An unreadable extracted value produces `needs_review`, never `fail`: a value
 * the platform cannot read is unknown, and reporting it as a mismatch would be
 * asserting something the data does not support.
 */
function comparisonRule(comparison: FieldComparison): ReconciliationRule {
  return (context) => {
    const rows = context.extractionRows.filter(
      (row) => row.field === comparison.field,
    )

    if (rows.length === 0) {
      return notApplicable(
        comparison.ruleCode,
        comparison.severity,
        comparison.title,
        `No value has been extracted for "${comparison.field}", so there is nothing to compare.`,
      )
    }

    const expectedValue =
      comparison.field === 'area'
        ? context.parcel.areaDecimal
        : comparison.field === 'share'
          ? formatShare({
              numerator: BigInt(context.parcel.shareNumerator),
              denominator: BigInt(context.parcel.shareDenominator),
            })
          : comparison.field === 'khatian'
            ? context.parcel.khatianNumber
            : context.parcel.mouza

    // Each reading is classified once: a value the platform cannot parse is
    // unknown (unreadable), never a disagreement.
    const verdicts = new Map<string, ComparisonVerdict>()
    for (const row of rows) {
      verdicts.set(
        row.id,
        row.isUnclear ? 'unreadable' : comparison.compare(effectiveValue(row), expectedValue),
      )
    }

    const unreadable = rows.filter((row) => verdicts.get(row.id) === 'unreadable')
    const readable = rows.filter((row) => verdicts.get(row.id) === 'agree')
    const unreadableNote =
      unreadable.length > 0
        ? ` ${unreadable.length} further value(s) for this field are unreadable.`
        : ''

    if (unreadable.length === rows.length) {
      return problem(
        comparison.ruleCode,
        comparison.severity,
        'needs_review',
        comparison.findingKind,
        {
          title: `${comparison.title} — value unreadable`,
          explanation: `Every extracted "${comparison.field}" value is unreadable, so no comparison is possible. An unreadable value is unknown, not wrong.`,
          observedValue: null,
          expectedValue,
          evidenceReference: rows[0]?.pageReference ?? null,
          recordReferences: rows.map((row) => ({
            entityType: 'extraction',
            entityId: row.id,
            label: row.field,
          })),
        },
      )
    }

    const disagreements = rows.filter((row) => verdicts.get(row.id) === 'disagree')

    if (disagreements.length === 0 && unreadable.length === 0) {
      return pass(comparison.ruleCode, comparison.severity, {
        title: comparison.title,
        explanation: `Every extracted "${comparison.field}" value matches the record exactly under exact arithmetic.`,
        observedValue: readable.map(effectiveValue).join(', '),
        expectedValue,
        evidenceReference: readable[0]?.pageReference ?? null,
        recordReferences: readable.map((row) => ({
          entityType: 'extraction',
          entityId: row.id,
          label: row.field,
        })),
      })
    }

    if (disagreements.length === 0) {
      return problem(
        comparison.ruleCode,
        comparison.severity,
        'needs_review',
        comparison.findingKind,
        {
          title: `${comparison.title} — partly unreadable`,
          explanation: `Readable values agree with the record.${unreadableNote}`,
          observedValue: readable.map(effectiveValue).join(', ') || null,
          expectedValue,
          evidenceReference: unreadable[0]?.pageReference ?? null,
          recordReferences: unreadable.map((row) => ({
            entityType: 'extraction',
            entityId: row.id,
            label: row.field,
          })),
        },
      )
    }

    return problem(
      comparison.ruleCode,
      comparison.severity,
      'fail',
      comparison.findingKind,
      {
        title: `${comparison.title} — does not match`,
        explanation: `The record says "${expectedValue}" while the reading says "${disagreements
          .map(effectiveValue)
          .join('", "')}". The two do not agree under exact arithmetic. This is a discrepancy to resolve; it is not a finding of wrongdoing.${unreadableNote}`,
        observedValue: disagreements.map(effectiveValue).join(', '),
        expectedValue,
        evidenceReference: disagreements[0]?.pageReference ?? null,
        recordReferences: disagreements.map((row) => ({
          entityType: 'extraction',
          entityId: row.id,
          label: row.field,
        })),
      },
    )
  }
}

/* -------------------------------------------------------------------------- */
/* Lineage rules                                                               */
/* -------------------------------------------------------------------------- */

const lineagePresenceRule: ReconciliationRule = (context) => {
  const ruleCode = 'LINEAGE_LINK_PRESENT'
  const total =
    context.outgoingLineage.length + context.incomingLineage.length

  if (total > 0) {
    return pass(ruleCode, 'medium', {
      title: 'Lineage links are recorded',
      explanation: `${total} lineage link(s) connect this parcel to another survey record.`,
      observedValue: `${total} link(s)`,
      expectedValue: 'at least one link',
      evidenceReference: null,
      recordReferences: [{ entityType: 'parcel', entityId: context.parcel.id }],
    })
  }

  return problem(ruleCode, 'medium', 'needs_review', 'lineage_break', {
    title: 'No lineage link is recorded',
    explanation:
      'This parcel is not connected to any earlier or later record. Without a link its history cannot be followed, which a reviewer should confirm.',
    observedValue: '0 links',
    expectedValue: 'at least one link',
    evidenceReference: null,
    recordReferences: [{ entityType: 'parcel', entityId: context.parcel.id }],
  })
}

const lineageCertaintyRule: ReconciliationRule = (context) => {
  const ruleCode = 'LINEAGE_EVIDENCE_AND_CERTAINTY'
  const links = [...context.outgoingLineage, ...context.incomingLineage]

  if (links.length === 0) {
    return notApplicable(
      ruleCode,
      'medium',
      'No lineage links to assess',
      'This parcel has no lineage links, so there is no certainty to check.',
    )
  }

  const confirmedWithoutEvidence = links.filter(
    (link) =>
      link.certainty === 'confirmed' &&
      (link.evidenceReference === null || link.evidenceReference.trim() === ''),
  )

  if (confirmedWithoutEvidence.length > 0) {
    return problem(ruleCode, 'high', 'fail', 'lineage_break', {
      title: 'A confirmed lineage link names no evidence',
      explanation: `${confirmedWithoutEvidence.length} link(s) are marked confirmed but cite nothing to check. A link cannot be presented as confirmed without evidence.`,
      observedValue: `${confirmedWithoutEvidence.length} confirmed without evidence`,
      expectedValue: 'every confirmed link cites evidence',
      evidenceReference: null,
      recordReferences: confirmedWithoutEvidence.map((link) => ({
        entityType: 'parcel_lineage',
        entityId: link.id,
      })),
    })
  }

  const unverified = links.filter((link) => link.certainty === 'unverified')
  const illustrative = links.filter((link) => link.certainty === 'illustrative')

  if (unverified.length > 0 || illustrative.length > 0) {
    return problem(ruleCode, 'medium', 'needs_review', 'lineage_break', {
      title: 'Some lineage links are not confirmed',
      explanation: `${unverified.length} unverified and ${illustrative.length} illustrative link(s). These are proposals until a reviewer confirms them, and must not be read as an established chain.`,
      observedValue: `${unverified.length} unverified, ${illustrative.length} illustrative`,
      expectedValue: 'every link confirmed with evidence',
      evidenceReference: null,
      recordReferences: [...unverified, ...illustrative].map((link) => ({
        entityType: 'parcel_lineage',
        entityId: link.id,
      })),
    })
  }

  return pass(ruleCode, 'medium', {
    title: 'Every lineage link is confirmed with evidence',
    explanation: `${links.length} link(s) are confirmed and each cites evidence.`,
    observedValue: `${links.length} confirmed with evidence`,
    expectedValue: 'every link confirmed with evidence',
    evidenceReference: null,
    recordReferences: links.map((link) => ({
      entityType: 'parcel_lineage',
      entityId: link.id,
    })),
  })
}

/**
 * Builds the split/merge area rule for one relation.
 *
 * Returns the rule itself rather than a promise, so the rule set stays a plain
 * array of functions; the rule it returns is asynchronous because it needs a
 * query.
 */
function splitOrMergeRule(
  database: Database,
  relation: 'split' | 'merge',
): ReconciliationRule {
  const ruleCode =
    relation === 'split' ? 'LINEAGE_SPLIT_AREA_SUM' : 'LINEAGE_MERGE_AREA_SUM'

  return async (context) => {
    const relevant =
      relation === 'split'
        ? context.outgoingLineage.filter((link) => link.relation === 'split')
        : context.incomingLineage.filter((link) => link.relation === 'merge')

    if (relevant.length === 0) {
      return notApplicable(
        ruleCode,
        'medium',
        `No ${relation} relationship to check`,
        `This parcel is not recorded as part of a ${relation}.`,
      )
    }

    const anchor = relevant[0]
    if (anchor === undefined) {
      return notApplicable(
        ruleCode,
        'medium',
        `No ${relation} relationship to check`,
        `This parcel is not recorded as part of a ${relation}.`,
      )
    }

    const note = await describeLineageArithmetic(database, {
      fromParcelId: anchor.fromParcelId,
      toParcelId: anchor.toParcelId,
      relation,
    })

    if (note === null) {
      return notApplicable(
        ruleCode,
        'medium',
        `${relation} areas could not be compared`,
        `The ${relation} relationship exists but one of the areas involved could not be read, so no arithmetic comparison was possible.`,
      )
    }

    if (note.exactlyEqual) {
      return pass(ruleCode, 'medium', {
        title:
          relation === 'split'
            ? 'Split areas add up exactly'
            : 'Merged areas add up exactly',
        explanation: `The ${relation} parts sum to ${note.observedTotal}, exactly equal to ${note.expectedTotal}. Equality is a consistency observation and does not establish legal continuity or ownership.`,
        observedValue: note.observedParts.join(' + ') + ` = ${note.observedTotal}`,
        expectedValue: note.expectedTotal,
        evidenceReference: null,
        recordReferences: [{ entityType: 'parcel', entityId: context.parcel.id }],
      })
    }

    const difference = compareAreas(note.observedTotal, note.expectedTotal)

    return problem(ruleCode, 'medium', 'fail', 'area_mismatch', {
      title:
        relation === 'split'
          ? 'Split areas do not add up to the original'
          : 'Merged areas do not add up to the new record',
      explanation: `The ${relation} parts sum to ${note.observedTotal} while the other side records ${note.expectedTotal}, a ${
        difference > 0 ? 'surplus' : 'shortfall'
      }. A partial record is common and expected; this is a discrepancy to resolve, not a finding of wrongdoing.`,
      observedValue: note.observedParts.join(' + ') + ` = ${note.observedTotal}`,
      expectedValue: note.expectedTotal,
      evidenceReference: null,
      recordReferences: [{ entityType: 'parcel', entityId: context.parcel.id }],
    })
  }
}

/* -------------------------------------------------------------------------- */
/* Finding rules                                                               */
/* -------------------------------------------------------------------------- */

const openFindingsRule: ReconciliationRule = (context) => {
  const ruleCode = 'FINDINGS_UNRESOLVED'
  const blocking = context.openFindings.filter(
    (finding) => finding.severity === 'high',
  )

  if (context.openFindings.length === 0) {
    return pass(ruleCode, 'high', {
      title: 'No findings are unresolved',
      explanation: 'Every finding raised against this record has been resolved or dismissed.',
      observedValue: '0 open findings',
      expectedValue: '0 open findings',
      evidenceReference: null,
      recordReferences: [{ entityType: 'parcel', entityId: context.parcel.id }],
    })
  }

  if (blocking.length > 0) {
    return problem(ruleCode, 'high', 'fail', 'other', {
      title: 'High-severity findings are unresolved',
      explanation: `${blocking.length} high-severity finding(s) remain open. These must be resolved or dismissed with a recorded reason before the record can be considered ready.`,
      observedValue: `${blocking.length} high-severity open`,
      expectedValue: '0 open high-severity findings',
      evidenceReference: null,
      recordReferences: blocking.map((finding) => ({
        entityType: 'finding',
        entityId: finding.id,
        label: finding.ruleCode ?? finding.kind,
      })),
    })
  }

  return problem(ruleCode, 'medium', 'needs_review', null, {
    title: 'Some findings are still open',
    explanation: `${context.openFindings.length} finding(s) remain open at lower severity. They do not block, but a reviewer should record an outcome.`,
    observedValue: `${context.openFindings.length} open`,
    expectedValue: '0 open findings',
    evidenceReference: null,
    recordReferences: context.openFindings.map((finding) => ({
      entityType: 'finding',
      entityId: finding.id,
    })),
  })
}

const lifecycleRule: ReconciliationRule = (context) => {
  const ruleCode = 'RECORD_LIFECYCLE_ACTIVE'

  if (context.parcel.lifecycle === 'active') {
    return pass(ruleCode, 'high', {
      title: 'Record is in active use',
      explanation: 'The parcel has not been retired, so it is part of active work.',
      observedValue: 'active',
      expectedValue: 'active',
      evidenceReference: null,
      recordReferences: [{ entityType: 'parcel', entityId: context.parcel.id }],
    })
  }

  return problem(ruleCode, 'high', 'fail', 'other', {
    title: 'Record has been retired',
    explanation: `The parcel was retired${
      context.parcel.retirementReason === null
        ? ''
        : ` (${context.parcel.retirementReason})`
    }. A retired record is not ready for further work.`,
    observedValue: 'retired',
    expectedValue: 'active',
    evidenceReference: null,
    recordReferences: [{ entityType: 'parcel', entityId: context.parcel.id }],
  })
}

/** Rules that need one or more database reads, built per database handle. */
function asyncRules(database: Database): ReconciliationRule[] {
  return [splitOrMergeRule(database, 'split'), splitOrMergeRule(database, 'merge')]
}

/**
 * Runs the whole rule set against a parcel.
 *
 * Pure and read-only: it writes nothing. The caller decides whether to record a
 * readiness report or raise findings from the results.
 */
export async function evaluateReconciliation(
  database: Database,
  context: ReconciliationContext,
): Promise<RuleResult[]> {
  const results: RuleResult[] = []

  // Rules are awaited in a stable order — pure ones first, then the ones that
  // read the database — so the result list is deterministic for a given record.
  for (const rule of SYNCHRONOUS_RULES) {
    results.push(await rule(context))
  }

  for (const rule of asyncRules(database)) {
    results.push(await rule(context))
  }

  return results.sort((a, b) => a.ruleCode.localeCompare(b.ruleCode))
}

const SYNCHRONOUS_RULES: readonly ReconciliationRule[] = [
  lifecycleRule,
  parcelAreaPositiveRule,
  parcelIdentityRule,
  parcelKhatianShapeRule,
  shareValidityRule,
  evidencePresentRule,
  extractionReviewStateRule,
  ...FIELD_COMPARISONS.map(comparisonRule),
  lineagePresenceRule,
  lineageCertaintyRule,
  openFindingsRule,
]

/** The overall verdict implied by a set of rule results. */
export function summariseOutcomes(results: readonly RuleResult[]): {
  outcome: 'ready_for_review' | 'needs_review' | 'not_ready'
  counts: Record<RuleOutcome, number>
  summary: string
} {
  const counts: Record<RuleOutcome, number> = {
    pass: 0,
    fail: 0,
    needs_review: 0,
    not_applicable: 0,
  }
  for (const result of results) counts[result.outcome] += 1

  const highFailures = results.filter(
    (result) => result.outcome === 'fail' && result.severity === 'high',
  )

  if (highFailures.length > 0) {
    return {
      outcome: 'not_ready',
      counts,
      summary: `${counts.pass} check(s) passed, ${counts.fail} failed, ${counts.needs_review} need a reviewer. ${highFailures.length} high-severity failure(s) must be resolved first.`,
    }
  }

  const attention = counts.fail + counts.needs_review
  if (attention > 0) {
    return {
      outcome: 'needs_review',
      counts,
      summary: `${counts.pass} check(s) passed, ${counts.fail} failed, ${counts.needs_review} need a reviewer. Nothing high-severity is outstanding, but a person should decide.`,
    }
  }

  return {
    outcome: 'ready_for_review',
    counts,
    summary: `${counts.pass} check(s) passed with nothing outstanding. This is administrative decision support: it is not an approval, and it makes no statement about ownership.`,
  }
}

/** Severity order used when a caller wants to sort findings. */
export const SEVERITY_ORDER: Readonly<Record<FindingSeverity, number>> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
}
