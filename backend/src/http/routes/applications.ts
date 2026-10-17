import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'

import type { User } from '../../db/schema/users.js'
import { parsePagination } from '../../lib/pagination.js'
import {
  createApplication,
  listApplications,
  loadVisibleApplicationDetail,
  transitionApplication,
  updateApplication,
} from '../../services/applications.js'
import { requireAuthenticated } from '../auth-context.js'
import {
  applicationDetailSchema,
  applicationListQuerySchema,
  applicationSchema,
  createApplicationBodySchema,
  errorResponses,
  pageOf,
  transitionApplicationBodySchema,
  updateApplicationBodySchema,
  uuidParam,
} from '../schemas.js'

/**
 * Application endpoints.
 *
 * An application is a filing a person makes in this system. Authorisation is
 * explicit on every route and comes from the resolved session, never from a body
 * field: an `ownerId` in the body is honoured only for an administrator, and
 * nothing else about the caller's role or ownership is read from the request.
 *
 * Two things this module deliberately does not do:
 *
 * - It does not let a client set a status. `POST /:applicationId/transitions`
 *   asks for a transition, and the service decides whether that transition is
 *   possible from the state the row is in and whether the caller's role may
 *   perform it.
 * - It does not describe any state as an official outcome. `approved` and
 *   `rejected` are states in this tracker; see the README for the product
 *   decisions that would be needed before anything here could be presented as a
 *   government decision.
 */

/** Loads the acting account from the resolved session. */
function actor(request: FastifyRequest): User {
  return requireAuthenticated(request).user
}

export function applicationRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.get(
    '/applications',
    {
      schema: {
        tags: ['applications'],
        summary: 'List applications',
        description:
          'An applicant sees only their own filings; a reviewer or administrator sees every application. Each item carries `trackingNumber: null` while the filing is still a draft.',
        querystring: applicationListQuerySchema,
        response: {
          200: pageOf(applicationSchema),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const page = await listApplications(app.database, {
        user: actor(request),
        filters: {
          ...(request.query.status === undefined ? {} : { status: request.query.status }),
          ...(request.query.type === undefined ? {} : { type: request.query.type }),
          ...(request.query.ownerId === undefined ? {} : { ownerId: request.query.ownerId }),
          ...(request.query.parcelId === undefined ? {} : { parcelId: request.query.parcelId }),
        },
        pagination: parsePagination(request.query),
      })

      return reply.code(200).send(page)
    },
  )

  typed.post(
    '/applications',
    {
      schema: {
        tags: ['applications'],
        summary: 'Create an application',
        description:
          'Records a filing as a **draft**, owned by the signed-in account. A reviewer may not create a filing; an administrator may file on behalf of another account by passing `ownerId`. A draft has no tracking number until it is submitted, which is a separate transition.',
        body: createApplicationBodySchema,
        response: {
          201: applicationSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const application = await createApplication(app.database, {
        user: actor(request),
        type: request.body.type,
        district: request.body.district,
        upazila: request.body.upazila,
        mouza: request.body.mouza,
        khatianNumber: request.body.khatianNumber,
        dagNumber: request.body.dagNumber,
        ...(request.body.areaDecimal === undefined
          ? {}
          : { areaDecimal: request.body.areaDecimal }),
        ...(request.body.share === undefined ? {} : { share: request.body.share }),
        declaredDocuments: request.body.documents,
        ...(request.body.parcelId === undefined ? {} : { parcelId: request.body.parcelId }),
        ...(request.body.ownerId === undefined ? {} : { ownerId: request.body.ownerId }),
        requestId: request.id,
      })

      return reply.code(201).send(application)
    },
  )

  typed.get(
    '/applications/:applicationId',
    {
      schema: {
        tags: ['applications'],
        summary: 'Read one application',
        description:
          'Includes the derived `timeline`, read from the append-only audit trail, and the server’s `today` so a client can compare a deadline. A filing the caller may not see is reported as `404`, identically to one that does not exist.',
        params: uuidParam('applicationId'),
        response: {
          200: applicationDetailSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const application = await loadVisibleApplicationDetail(
        app.database,
        actor(request),
        request.params.applicationId,
      )

      return reply.code(200).send(application)
    },
  )

  typed.patch(
    '/applications/:applicationId',
    {
      schema: {
        tags: ['applications'],
        summary: 'Update an application',
        description:
          'Requires the `version` last read; a mismatch is a `409 concurrent_modification` rather than a silent overwrite. An applicant may edit only their own filing and only while it is a draft. A reviewer may not rewrite a filing at all; an administrator may correct one, and the change is audited.',
        params: uuidParam('applicationId'),
        body: updateApplicationBodySchema,
        response: {
          200: applicationSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const application = await updateApplication(app.database, {
        user: actor(request),
        applicationId: request.params.applicationId,
        version: request.body.version,
        ...(request.body.district === undefined ? {} : { district: request.body.district }),
        ...(request.body.upazila === undefined ? {} : { upazila: request.body.upazila }),
        ...(request.body.mouza === undefined ? {} : { mouza: request.body.mouza }),
        ...(request.body.khatianNumber === undefined
          ? {}
          : { khatianNumber: request.body.khatianNumber }),
        ...(request.body.dagNumber === undefined
          ? {}
          : { dagNumber: request.body.dagNumber }),
        ...(request.body.areaDecimal === undefined
          ? {}
          : { areaDecimal: request.body.areaDecimal }),
        ...(request.body.share === undefined ? {} : { share: request.body.share }),
        ...(request.body.documents === undefined
          ? {}
          : { declaredDocuments: request.body.documents }),
        ...(request.body.parcelId === undefined ? {} : { parcelId: request.body.parcelId }),
        requestId: request.id,
      })

      return reply.code(200).send(application)
    },
  )

  typed.post(
    '/applications/:applicationId/transitions',
    {
      schema: {
        tags: ['applications'],
        summary: 'Move an application to its next state',
        description:
          'Requests one transition from the workflow. The transition must be possible from the application’s current state and permitted for the caller’s role, otherwise the request is rejected with `409 invalid_transition` (the state does not allow that move, or the application has already settled) or `403 forbidden` (the caller’s role may not perform it). A rejection without a reason is a `400`. Requires the `version` last read. This records a state in the tracker, not a government decision.',
        params: uuidParam('applicationId'),
        body: transitionApplicationBodySchema,
        response: {
          200: applicationSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const application = await transitionApplication(app.database, {
        user: actor(request),
        applicationId: request.params.applicationId,
        version: request.body.version,
        toStatus: request.body.toStatus,
        ...(request.body.note === undefined ? {} : { note: request.body.note }),
        ...(request.body.nextStep === undefined ? {} : { nextStep: request.body.nextStep }),
        ...(request.body.deadline === undefined ? {} : { deadline: request.body.deadline }),
        requestId: request.id,
      })

      return reply.code(200).send(application)
    },
  )
}
