import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { VALIDATION_RULES_VERSION } from '../../src/config/constants.js'
import {
  API,
  createAccount,
  createParcel,
  createTestApi,
  expectError,
  expectStatus,
  signIn,
  unknownUuid,
  type TestApi,
  type TestClient,
} from '../helpers/api.js'
import { closeTestDatabase } from '../helpers/database.js'

/**
 * Deterministic reconciliation and mutation-readiness reports.
 *
 * The claims worth proving:
 *
 * 1. Read-only evaluation writes nothing; only the `POST` raises findings.
 * 2. Arithmetic is exact and script-aware: a Bengali-digit area agrees with an
 *    ASCII one, because the comparison is made on integers, not on floats.
 * 3. An unreadable value is reported as unusable rather than as a mismatch — a
 *    value the platform cannot read is unknown, not wrong.
 * 4. A readiness report is a checklist with reasons, never a score and never an
 *    approval.
 */

let api: TestApi
let applicant: TestClient
let otherApplicant: TestClient
let reviewer: TestClient
let admin: TestClient

beforeAll(async () => {
  api = await createTestApi()

  applicant = await signIn(api.app, await createAccount(api.database, 'applicant'))
  otherApplicant = await signIn(api.app, await createAccount(api.database, 'applicant'))
  reviewer = await signIn(api.app, await createAccount(api.database, 'reviewer'))
  admin = await signIn(api.app, await createAccount(api.database, 'admin'))
})

afterAll(async () => {
  await api.close()
  await closeTestDatabase()
})

interface RuleBody {
  ruleCode: string
  severity: string
  outcome: 'pass' | 'fail' | 'needs_review' | 'not_applicable'
  title: string
  explanation: string
  observedValue: string | null
  expectedValue: string | null
  evidenceReference: string | null
  findingKind: string | null
}

interface ReconciliationBody {
  parcelId: string
  rulesVersion: string
  rules: RuleBody[]
  summary: {
    outcome: 'ready_for_review' | 'needs_review' | 'not_ready'
    counts: Record<string, number>
    summary: string
  }
  raisedFindings: { id: string; ruleCode: string; title: string }[]
  existingOpenRules: string[]
}

interface ChecklistItemBody {
  id: string
  ruleCode: string
  outcome: string
  severity: string
  title: string
  explanation: string
  observedValue: string | null
  expectedValue: string | null
  evidenceReference: string | null
  sortOrder: number
}

interface ReportBody {
  id: string
  parcelId: string
  requestedBy: string | null
  outcome: 'ready_for_review' | 'needs_review' | 'not_ready'
  rulesVersion: string
  summary: string
  counts: Record<string, number> | null
  createdAt: string
  items: ChecklistItemBody[]
}

let sequence = 0
function runToken(): string {
  sequence += 1
  return `${Date.now().toString(36)}${sequence}${Math.random().toString(36).slice(2, 6)}`
}

function ruleOf(body: ReconciliationBody, ruleCode: string): RuleBody {
  const rule = body.rules.find((item) => item.ruleCode === ruleCode)
  if (rule === undefined) {
    throw new Error(`Expected the rule "${ruleCode}" to be evaluated.`)
  }
  return rule
}

async function addExtraction(
  client: TestClient,
  parcelId: string,
  field: string,
  recordedValue: string,
): Promise<void> {
  const response = await client.post(`${API}/parcels/${parcelId}/extractions`, {
    field,
    recordedValue,
  })
  expectStatus(response, 201)
}

/**
 * A parcel that passes every check: a numeric khatian, a positive area, a valid
 * share, no readings to compare, and a confirmed lineage link carrying evidence.
 */
async function readyParcel(): Promise<{ first: string; second: string }> {
  const token = runToken()
  const first = await createParcel(applicant, {
    khatianNumber: '104',
    mouza: `Ready Mouza ${token}`,
    jlNumber: `JL-READY-A-${token}`,
    areaDecimal: '125.0000',
  })
  const second = await createParcel(applicant, {
    khatianNumber: '204',
    mouza: `Ready Mouza ${token}`,
    jlNumber: `JL-READY-B-${token}`,
    areaDecimal: '125.0000',
  })

  // Only a reviewer may mint a confirmed link, and only with evidence.
  const link = await reviewer.post(`${API}/parcels/${first.id}/lineage`, {
    toParcelId: second.id,
    relation: 'continued',
    certainty: 'confirmed',
    evidenceReference: `RS khatian 104, ${token}`,
  })
  expectStatus(link, 201)

  return { first: first.id, second: second.id }
}

describe('GET /parcels/:parcelId/reconciliation', () => {
  it('evaluates every rule and writes nothing', async () => {
    const parcel = await createParcel(applicant, { khatianNumber: '104' })

    const response = await applicant.get(`${API}/parcels/${parcel.id}/reconciliation`)

    expectStatus(response, 200)
    const body = response.json() as ReconciliationBody

    expect(body.parcelId).toBe(parcel.id)
    expect(body.rulesVersion).toBe(VALIDATION_RULES_VERSION)
    expect(body.rules.length).toBeGreaterThan(8)
    // Deterministic ordering, so two runs are comparable.
    expect(body.rules.map((rule) => rule.ruleCode)).toEqual(
      [...body.rules.map((rule) => rule.ruleCode)].sort(),
    )
    // A read-only evaluation raises nothing, including on a record that fails.
    expect(body.raisedFindings).toEqual([])
    expect(body.existingOpenRules).toEqual([])

    const findings = await applicant.get(`${API}/parcels/${parcel.id}/findings`)
    expectStatus(findings, 200)
    expect((findings.json() as { items: unknown[] }).items).toEqual([])
  })

  it('reports a passing record as ready for review, not approved', async () => {
    const { first } = await readyParcel()

    const response = await applicant.get(`${API}/parcels/${first}/reconciliation`)
    expectStatus(response, 200)
    const body = response.json() as ReconciliationBody

    expect(body.summary.outcome).toBe('ready_for_review')
    for (const rule of body.rules) {
      expect(['pass', 'not_applicable']).toContain(rule.outcome)
    }

    // The wording is explicit that this is decision support.
    expect(body.summary.summary.toLowerCase()).toContain('not an approval')
  })

  it('compares a Bengali-digit reading with an ASCII area exactly', async () => {
    const parcel = await createParcel(applicant, {
      khatianNumber: '104',
      areaDecimal: '125.0000',
    })
    // ১২৫.০০০০ is 125.0000 written in Bengali digits. These must be equal.
    await addExtraction(applicant, parcel.id, 'area', '১২৫.০০০০')

    const response = await applicant.get(`${API}/parcels/${parcel.id}/reconciliation`)
    expectStatus(response, 200)

    const rule = ruleOf(
      response.json() as ReconciliationBody,
      'EXTRACTION_AREA_MATCHES_RECORD',
    )
    expect(rule.outcome).toBe('pass')
    expect(rule.observedValue).toBe('১২৫.০০০০')
  })

  it('treats an unreadable reading as unknown, never as a mismatch', async () => {
    const parcel = await createParcel(applicant, {
      khatianNumber: '104',
      areaDecimal: '125.0000',
    })
    await addExtraction(applicant, parcel.id, 'area', '১২৫ দশমিক শূন্য')

    const response = await applicant.get(`${API}/parcels/${parcel.id}/reconciliation`)
    expectStatus(response, 200)
    const body = response.json() as ReconciliationBody

    const rule = ruleOf(body, 'EXTRACTION_AREA_MATCHES_RECORD')
    expect(rule.outcome).toBe('needs_review')
    expect(rule.outcome).not.toBe('fail')
    expect(rule.explanation.toLowerCase()).toContain('unknown')

    // Nothing high-severity failed, so the record needs a person rather than
    // being blocked.
    expect(body.summary.outcome).toBe('needs_review')
  })

  it('fails the comparison when the reading genuinely differs', async () => {
    const parcel = await createParcel(applicant, {
      khatianNumber: '104',
      areaDecimal: '125.0000',
    })
    await addExtraction(applicant, parcel.id, 'area', '120.5000')

    const response = await applicant.get(`${API}/parcels/${parcel.id}/reconciliation`)
    expectStatus(response, 200)
    const body = response.json() as ReconciliationBody

    const rule = ruleOf(body, 'EXTRACTION_AREA_MATCHES_RECORD')
    expect(rule.outcome).toBe('fail')
    expect(rule.findingKind).toBe('area_mismatch')
    expect(rule.observedValue).toBe('120.5000')
    expect(rule.expectedValue).toBe('125.0000')
    // A discrepancy to resolve, not an accusation.
    expect(rule.explanation.toLowerCase()).toContain('not a finding of wrongdoing')

    expect(body.summary.outcome).toBe('not_ready')
    expect(body.summary.summary).toContain('high-severity')
  })

  it('reports another applicant’s parcel as not found', async () => {
    const theirs = await createParcel(otherApplicant)

    const response = await applicant.get(`${API}/parcels/${theirs.id}/reconciliation`)

    expectError(response, 404, 'not_found')
  })

  it('reports an unknown parcel as not found', async () => {
    const response = await applicant.get(`${API}/parcels/${unknownUuid()}/reconciliation`)

    expectError(response, 404, 'not_found')
  })
})

describe('POST /parcels/:parcelId/reconciliation', () => {
  it('raises a finding per actionable failure and names the rule', async () => {
    const parcel = await createParcel(applicant, {
      // A non-numeric khatian and no lineage link are both actionable.
      khatianNumber: `KH-${runToken()}`,
    })

    const response = await applicant.post(`${API}/parcels/${parcel.id}/reconciliation`)
    expectStatus(response, 200)
    const body = response.json() as ReconciliationBody

    const actionable = body.rules.filter(
      (rule) => rule.outcome !== 'pass' && rule.findingKind !== null,
    )
    expect(body.raisedFindings.map((item) => item.ruleCode).sort()).toEqual(
      actionable.map((rule) => rule.ruleCode).sort(),
    )

    const findings = await applicant.get(`${API}/parcels/${parcel.id}/findings`)
    expectStatus(findings, 200)
    const items = (findings.json() as { items: { ruleCode: string | null }[] }).items
    expect(items.length).toBe(body.raisedFindings.length)
    for (const item of items) expect(item.ruleCode).toEqual(expect.any(String))
  })

  it('raises nothing further when the same rule is still open', async () => {
    const parcel = await createParcel(applicant, { khatianNumber: `KH-${runToken()}` })

    const first = await applicant.post(`${API}/parcels/${parcel.id}/reconciliation`)
    expectStatus(first, 200)
    const firstCodes = (first.json() as ReconciliationBody).raisedFindings.map(
      (item) => item.ruleCode,
    )

    const second = await applicant.post(`${API}/parcels/${parcel.id}/reconciliation`)
    expectStatus(second, 200)
    const secondBody = second.json() as ReconciliationBody

    expect(secondBody.raisedFindings).toEqual([])
    expect(secondBody.existingOpenRules.sort()).toEqual([...firstCodes].sort())
  })

  it('refuses to evaluate a parcel the caller cannot see', async () => {
    const theirs = await createParcel(otherApplicant)

    const response = await applicant.post(`${API}/parcels/${theirs.id}/reconciliation`)

    expectError(response, 404, 'not_found')
  })

  it('requires authentication and a CSRF token', async () => {
    const parcel = await createParcel(applicant)

    const anonymous = await api.app.inject({
      method: 'POST',
      url: `${API}/parcels/${parcel.id}/reconciliation`,
    })
    expectError(anonymous, 401, 'unauthenticated')

    const noCsrf = await applicant.post(
      `${API}/parcels/${parcel.id}/reconciliation`,
      undefined,
      { withCsrf: false },
    )
    expectError(noCsrf, 403, 'forbidden')
  })
})

describe('readiness reports', () => {
  it('reports 404 before any report exists', async () => {
    const parcel = await createParcel(applicant)

    const response = await applicant.get(`${API}/parcels/${parcel.id}/readiness/latest`)

    expectError(response, 404, 'not_found')
  })

  it('stores a checklist with one item per rule and a plain-language summary', async () => {
    const { first } = await readyParcel()

    const response = await applicant.post(`${API}/parcels/${first}/readiness`)
    expectStatus(response, 201)
    const report = response.json() as ReportBody

    expect(report.parcelId).toBe(first)
    expect(report.requestedBy).toBe(applicant.account.id)
    expect(report.rulesVersion).toBe(VALIDATION_RULES_VERSION)
    expect(report.outcome).toBe('ready_for_review')
    expect(report.items.length).toBeGreaterThan(8)

    // Items are ordered, and each carries the reasoning a reviewer needs.
    expect(report.items.map((item) => item.sortOrder)).toEqual(
      report.items.map((_item, index) => index),
    )
    for (const item of report.items) {
      expect(item.ruleCode).toEqual(expect.any(String))
      expect(['pass', 'fail', 'needs_review', 'not_applicable']).toContain(item.outcome)
      expect(item.explanation.length).toBeGreaterThan(0)
    }

    expect(report.summary.toLowerCase()).toContain('not an approval')
    expect(report.summary.toLowerCase()).toContain('ownership')

    // The counts describe the checklist rather than a score.
    const counted = Object.values(report.counts ?? {}).reduce(
      (total, value) => total + value,
      0,
    )
    expect(counted).toBe(report.items.length)
  })

  it('reads back through both the report and the latest-report routes', async () => {
    const { first } = await readyParcel()
    const created = await applicant.post(`${API}/parcels/${first}/readiness`)
    expectStatus(created, 201)
    const report = created.json() as ReportBody

    const byId = await applicant.get(`${API}/readiness-reports/${report.id}`)
    expectStatus(byId, 200)
    expect((byId.json() as ReportBody).id).toBe(report.id)

    const latest = await applicant.get(`${API}/parcels/${first}/readiness/latest`)
    expectStatus(latest, 200)
    expect((latest.json() as ReportBody).id).toBe(report.id)
  })

  it('keeps the previous report when a new one is generated', async () => {
    const { first } = await readyParcel()

    const firstReport = await applicant.post(`${API}/parcels/${first}/readiness`)
    expectStatus(firstReport, 201)
    const reportOne = firstReport.json() as ReportBody
    expect(reportOne.outcome).toBe('ready_for_review')

    // A genuine change between the two reports: an unreviewed reading appears,
    // so the second checklist differs from the first.
    await addExtraction(applicant, first, 'area', '125.0000')

    const secondReport = await applicant.post(`${API}/parcels/${first}/readiness`)
    expectStatus(secondReport, 201)
    const reportTwo = secondReport.json() as ReportBody
    expect(reportTwo.id).not.toBe(reportOne.id)
    expect(reportTwo.outcome).toBe('needs_review')

    const listing = await applicant.get(`${API}/parcels/${first}/readiness`)
    expectStatus(listing, 200)
    const listed = (listing.json() as { items: { id: string }[] }).items
    // Newest first, and the superseded report is still listed.
    expect(listed.map((item) => item.id)).toEqual([reportTwo.id, reportOne.id])

    // The earlier report keeps its own checklist, exactly as it was issued.
    const reloaded = await applicant.get(`${API}/readiness-reports/${reportOne.id}`)
    expectStatus(reloaded, 200)
    const reloadedBody = reloaded.json() as ReportBody
    expect(reloadedBody.outcome).toBe('ready_for_review')
    expect(reloadedBody.items.length).toBe(reportOne.items.length)
  })

  it('records a retired record as not ready, with the retirement reason', async () => {
    const parcel = await createParcel(applicant, { khatianNumber: '104' })

    const retired = await applicant.post(`${API}/parcels/${parcel.id}/retire`, {
      version: parcel.version,
      reason: 'Withdrawn so a corrected filing can be made.',
    })
    expectStatus(retired, 200)

    const response = await applicant.post(`${API}/parcels/${parcel.id}/readiness`)
    expectStatus(response, 201)
    const report = response.json() as ReportBody

    const lifecycle = report.items.find(
      (item) => item.ruleCode === 'RECORD_LIFECYCLE_ACTIVE',
    )
    expect(lifecycle?.outcome).toBe('fail')
    expect(lifecycle?.explanation).toContain('Withdrawn so a corrected filing can be made.')
    // Retiring is high severity, so the record is blocked rather than flagged.
    expect(report.outcome).toBe('not_ready')
  })

  it('lets a reviewer generate and read a report for a filing they do not own', async () => {
    const parcel = await createParcel(applicant)

    const created = await reviewer.post(`${API}/parcels/${parcel.id}/readiness`)
    expectStatus(created, 201)
    const report = created.json() as ReportBody

    expect(report.requestedBy).toBe(reviewer.account.id)

    const reloaded = await admin.get(`${API}/readiness-reports/${report.id}`)
    expectStatus(reloaded, 200)
  })

  it('reports another applicant’s report as not found', async () => {
    const parcel = await createParcel(otherApplicant)
    const created = await otherApplicant.post(`${API}/parcels/${parcel.id}/readiness`)
    expectStatus(created, 201)
    const report = created.json() as ReportBody

    expectError(
      await applicant.get(`${API}/readiness-reports/${report.id}`),
      404,
      'not_found',
    )
    expectError(
      await applicant.get(`${API}/parcels/${parcel.id}/readiness`),
      404,
      'not_found',
    )
  })

  it('reports an unknown report as not found', async () => {
    const response = await applicant.get(`${API}/readiness-reports/${unknownUuid()}`)

    expectError(response, 404, 'not_found')
  })

  it('requires a CSRF token to generate a report', async () => {
    const parcel = await createParcel(applicant)

    const response = await applicant.post(
      `${API}/parcels/${parcel.id}/readiness`,
      undefined,
      { withCsrf: false },
    )

    expectError(response, 403, 'forbidden')
  })
})
