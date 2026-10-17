import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { VALIDATION_RULES_VERSION } from '../../config/constants.js'
import type { User } from '../../db/schema/users.js'
import { parsePagination } from '../../lib/pagination.js'
import {
  listExtractionsForParcel,
  recordManualExtraction,
} from '../../services/extractions.js'
import {
  changeParcelLifecycle,
  createParcel,
  listParcels,
  loadVisibleParcel,
  loadVisibleParcelView,
  updateParcel,
} from '../../services/parcels.js'
import { reconcileParcel } from '../../services/reconciliation.js'
import { listFindingsForParcel, toFindingView } from '../../services/review.js'
import { requireAuthenticated } from '../auth-context.js'
import {
  createParcelBodySchema,
  errorResponses,
  extractionSchema,
  findingSchema,
  lifecycleBodySchema,
  manualExtractionBodySchema,
  pageOf,
  parcelListQuerySchema,
  parcelSchema,
  reconciliationResultSchema,
  updateParcelBodySchema,
  uuidParam,
} from '../schemas.js'

/**
 * Parcel endpoints.
 *
 * Authorisation is explicit on every route rather than implied by registration.
 * Nothing here reads an owner, a role, or a user identifier from the request:
 * those come from the resolved session, and a body field that looks like one
 * (`ownerId`) is ignored unless the caller is an administrator.
 *
 * There is no delete route. Withdrawing a record from active use is
 * `POST /:parcelId/retire`, which keeps the evidence and history intact.
 */

/** Loads the acting account from the resolved session. */
function actor(request: FastifyRequest): User {
  return requireAuthenticated(request).user
}

export function parcelRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.get(
    '/parcels',
    {
      schema: {
        tags: ['parcels'],
        summary: 'List parcel records',
        description:
          'An applicant sees only their own filings; a reviewer or administrator sees every parcel, including the unowned synthetic demo records. Demo records are marked by `origin: "synthetic_demo"`.',
        querystring: parcelListQuerySchema,
        response: {
          200: pageOf(parcelSchema),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const page = await listParcels(app.database, {
        user: actor(request),
        filters: {
          ...(request.query.survey === undefined ? {} : { survey: request.query.survey }),
          ...(request.query.district === undefined
            ? {}
            : { district: request.query.district }),
          ...(request.query.upazila === undefined
            ? {}
            : { upazila: request.query.upazila }),
          ...(request.query.mouza === undefined ? {} : { mouza: request.query.mouza }),
          ...(request.query.khatianNumber === undefined
            ? {}
            : { khatianNumber: request.query.khatianNumber }),
          ...(request.query.lifecycle === undefined
            ? {}
            : { lifecycle: request.query.lifecycle }),
          ...(request.query.origin === undefined ? {} : { origin: request.query.origin }),
        },
        pagination: parsePagination(request.query),
      })

      return reply.code(200).send(page)
    },
  )

  typed.post(
    '/parcels',
    {
      schema: {
        tags: ['parcels'],
        summary: 'Create a parcel record',
        description:
          'Creates a record owned by the signed-in account, with `origin: "user_created"`. A reviewer may not create filings; an administrator may create one on behalf of another account by passing `ownerId`.',
        body: createParcelBodySchema,
        response: {
          201: parcelSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const parcel = await createParcel(app.database, {
        user: actor(request),
        survey: request.body.survey,
        khatianNumber: request.body.khatianNumber,
        mouza: request.body.mouza,
        jlNumber: request.body.jlNumber,
        upazila: request.body.upazila,
        district: request.body.district,
        areaDecimal: request.body.areaDecimal,
        shareNumerator: request.body.shareNumerator,
        shareDenominator: request.body.shareDenominator,
        dagNumbers: request.body.dagNumbers,
        ...(request.body.ownerId === undefined ? {} : { ownerId: request.body.ownerId }),
        requestId: request.id,
      })

      return reply.code(201).send(parcel)
    },
  )

  typed.get(
    '/parcels/:parcelId',
    {
      schema: {
        tags: ['parcels'],
        summary: 'Read one parcel record',
        description:
          'A record the caller may not see is reported as `404`, identically to one that does not exist, so an identifier cannot be used to discover other filings.',
        params: uuidParam('parcelId'),
        response: {
          200: parcelSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const parcel = await loadVisibleParcelView(
        app.database,
        actor(request),
        request.params.parcelId,
      )
      return reply.code(200).send(parcel)
    },
  )

  typed.patch(
    '/parcels/:parcelId',
    {
      schema: {
        tags: ['parcels'],
        summary: 'Update a parcel record',
        description:
          'Requires the `version` last read. A mismatch is a `409 concurrent_modification` rather than a silent overwrite. Only the owner or an administrator may change a filing; a reviewer records a review decision instead.',
        params: uuidParam('parcelId'),
        body: updateParcelBodySchema,
        response: {
          200: parcelSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const parcel = await updateParcel(app.database, {
        user: actor(request),
        parcelId: request.params.parcelId,
        version: request.body.version,
        ...(request.body.areaDecimal === undefined
          ? {}
          : { areaDecimal: request.body.areaDecimal }),
        ...(request.body.shareNumerator === undefined
          ? {}
          : { shareNumerator: request.body.shareNumerator }),
        ...(request.body.shareDenominator === undefined
          ? {}
          : { shareDenominator: request.body.shareDenominator }),
        ...(request.body.mouza === undefined ? {} : { mouza: request.body.mouza }),
        ...(request.body.jlNumber === undefined ? {} : { jlNumber: request.body.jlNumber }),
        ...(request.body.upazila === undefined ? {} : { upazila: request.body.upazila }),
        ...(request.body.district === undefined ? {} : { district: request.body.district }),
        ...(request.body.dagNumbers === undefined
          ? {}
          : { dagNumbers: request.body.dagNumbers }),
        requestId: request.id,
      })

      return reply.code(200).send(parcel)
    },
  )

  typed.post(
    '/parcels/:parcelId/retire',
    {
      schema: {
        tags: ['parcels'],
        summary: 'Retire a parcel record',
        description:
          'Withdraws a record from active use without deleting anything. The owner or an administrator may retire; a reason is required and recorded. Evidence, lineage, findings, and review history remain readable.',
        params: uuidParam('parcelId'),
        body: lifecycleBodySchema,
        response: {
          200: parcelSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const parcel = await changeParcelLifecycle(
        app.database,
        {
          user: actor(request),
          parcelId: request.params.parcelId,
          version: request.body.version,
          reason: request.body.reason,
          requestId: request.id,
        },
        'retired',
      )

      return reply.code(200).send(parcel)
    },
  )

  typed.post(
    '/parcels/:parcelId/reinstate',
    {
      schema: {
        tags: ['parcels'],
        summary: 'Reinstate a retired parcel record',
        description:
          'Administrators only. Returns the record to active use; the retirement decision stays in the audit trail.',
        params: uuidParam('parcelId'),
        body: lifecycleBodySchema,
        response: {
          200: parcelSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const parcel = await changeParcelLifecycle(
        app.database,
        {
          user: actor(request),
          parcelId: request.params.parcelId,
          version: request.body.version,
          reason: request.body.reason,
          requestId: request.id,
        },
        'active',
      )

      return reply.code(200).send(parcel)
    },
  )

  typed.get(
    '/parcels/:parcelId/findings',
    {
      schema: {
        tags: ['parcels'],
        summary: 'List a parcel record’s findings',
        description:
          'Findings are discrepancies for a reviewer to resolve. They are not determinations of fraud, and none of them constitutes an approval of the record.',
        params: uuidParam('parcelId'),
        response: {
          200: z.object({ items: z.array(findingSchema) }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const user = actor(request)
      await loadVisibleParcel(app.database, user, request.params.parcelId)
      const rows = await listFindingsForParcel(app.database, user, request.params.parcelId)

      return reply.code(200).send({ items: rows.map(toFindingView) })
    },
  )

  typed.get(
    '/parcels/:parcelId/extractions',
    {
      schema: {
        tags: ['extractions'],
        summary: 'List a parcel record’s extracted values',
        description:
          'Returns both what was read (`recordedValue`) and what a reviewer decided (`reviewedValue`), so an original reading is never overwritten by a correction.',
        params: uuidParam('parcelId'),
        response: {
          200: z.object({ items: z.array(extractionSchema) }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const rows = await listExtractionsForParcel(
        app.database,
        actor(request),
        request.params.parcelId,
      )
      return reply.code(200).send({ items: rows })
    },
  )

  typed.post(
    '/parcels/:parcelId/extractions',
    {
      schema: {
        tags: ['extractions'],
        summary: 'Record a value read by hand',
        description:
          'Records a value a person read directly, with no source document. This is a first-class case, not a degraded one: `provider` and `extractedAt` are null rather than naming a provider that did not exist.',
        params: uuidParam('parcelId'),
        body: manualExtractionBodySchema,
        response: {
          201: extractionSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const extraction = await recordManualExtraction(app.database, {
        user: actor(request),
        parcelId: request.params.parcelId,
        field: request.body.field,
        recordedValue: request.body.recordedValue,
        ...(request.body.pageReference === undefined
          ? {}
          : { pageReference: request.body.pageReference }),
        ...(request.body.isUnclear === undefined
          ? {}
          : { isUnclear: request.body.isUnclear }),
        requestId: request.id,
      })

      return reply.code(201).send(extraction)
    },
  )

  typed.get(
    '/parcels/:parcelId/reconciliation',
    {
      schema: {
        tags: ['reconciliation'],
        summary: 'Evaluate the deterministic rules (read-only)',
        description:
          'Runs the whole rule set and returns every result with what was observed, what was expected, and which records it refers to. Writes nothing. `POST` on the same path raises findings for what did not pass.',
        params: uuidParam('parcelId'),
        response: {
          200: reconciliationResultSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await reconcileParcel(app.database, {
        user: actor(request),
        parcelId: request.params.parcelId,
        persist: false,
        rulesVersion: VALIDATION_RULES_VERSION,
        requestId: request.id,
      })

      return reply.code(200).send(result)
    },
  )

  typed.post(
    '/parcels/:parcelId/reconciliation',
    {
      schema: {
        tags: ['reconciliation'],
        summary: 'Evaluate the rules and raise findings',
        description:
          'Runs the rule set and raises a finding for each non-passing check that has a finding kind. A rule already open on this parcel is not duplicated; a previously settled one is raised again only if the condition still holds, so the history shows it was seen, decided, and seen again.',
        params: uuidParam('parcelId'),
        response: {
          200: reconciliationResultSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await reconcileParcel(app.database, {
        user: actor(request),
        parcelId: request.params.parcelId,
        persist: true,
        rulesVersion: VALIDATION_RULES_VERSION,
        requestId: request.id,
      })

      return reply.code(200).send(result)
    },
  )
}
