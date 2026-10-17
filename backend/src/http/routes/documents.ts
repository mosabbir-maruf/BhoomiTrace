import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { ValidationError } from '../../lib/errors.js'
import { parsePagination } from '../../lib/pagination.js'
import {
  addDocumentPage,
  listDocumentPages,
  listDocuments,
  loadVisibleDocument,
  openDocumentFile,
  registerDocument,
  registerUploadedDocument,
  toDocumentView,
  updateDocument,
} from '../../services/documents.js'
import { requireAuthenticated } from '../auth-context.js'
import {
  addPageBodySchema,
  documentListQuerySchema,
  documentPageSchema,
  documentSchema,
  errorResponses,
  pageOf,
  registerDocumentBodySchema,
  updateDocumentBodySchema,
  uploadQuerySchema,
  uuidParam,
} from '../schemas.js'

/**
 * Source-document endpoints.
 *
 * ## Two ways in
 *
 * `POST /documents` registers metadata only — the manual-entry case, for a
 * record the platform holds no scan of. `POST /documents/upload` streams a file
 * into private storage and registers it. Both produce an ordinary document; a
 * document with no stored file is not a second-class record.
 *
 * ## What is deliberately absent
 *
 * There is no delete route. `extractions.source_document_id` is
 * `ON DELETE RESTRICT`, so a document that any extraction cites cannot be
 * removed at all, and the API simply does not offer removal as an option.
 *
 * `storageKey` never appears in a response: it is a server-generated path
 * identifier that a client has no legitimate use for. The storage schema is
 * proven by the response schema, which drops any field not declared here.
 *
 * ## Upload handling
 *
 * The declared content type is not trusted. The first bytes of the stream are
 * matched against known file signatures, the write is capped at
 * `UPLOAD_MAX_BYTES`, and the SHA-256 digest is computed while streaming. A file
 * that fails either check is removed before the request returns, and if the
 * database write then fails the file is removed too, so a rejected upload never
 * leaves an orphan behind.
 */

function actor(request: FastifyRequest): ReturnType<typeof requireAuthenticated>['user'] {
  return requireAuthenticated(request).user
}

/** Path parameter shared by every document route. */
const documentIdParams = uuidParam('documentId')

export function documentRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()
  const env = app.appEnv

  typed.get(
    '/documents',
    {
      schema: {
        tags: ['documents'],
        summary: 'List source documents',
        description:
          'An applicant sees only their own documents. A reviewer or administrator sees all of them, because review work requires following the evidence.',
        querystring: documentListQuerySchema,
        response: {
          200: pageOf(documentSchema),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const page = await listDocuments(app.database, {
        user: actor(request),
        filters: {
          ...(request.query.status === undefined ? {} : { status: request.query.status }),
          ...(request.query.kind === undefined ? {} : { kind: request.query.kind }),
          ...(request.query.reference === undefined
            ? {}
            : { reference: request.query.reference }),
          ...(request.query.title === undefined ? {} : { title: request.query.title }),
          ...(request.query.origin === undefined ? {} : { origin: request.query.origin }),
        },
        pagination: parsePagination(request.query),
      })

      return reply.code(200).send(page)
    },
  )

  typed.post(
    '/documents',
    {
      schema: {
        tags: ['documents'],
        summary: 'Register a source document without a stored file',
        description:
          'The manual-entry path. The document has no stored file, which the response makes explicit with `hasStoredFile: false`.',
        body: registerDocumentBodySchema,
        response: {
          201: documentSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const document = await registerDocument(app.database, {
        user: actor(request),
        title: request.body.title,
        kind: request.body.kind,
        ...(request.body.reference === undefined
          ? {}
          : { reference: request.body.reference }),
        ...(request.body.pageCount === undefined
          ? {}
          : { pageCount: request.body.pageCount }),
        ...(request.body.status === undefined ? {} : { status: request.body.status }),
        ...(request.body.ownerId === undefined ? {} : { ownerId: request.body.ownerId }),
        ...(request.body.pages === undefined ? {} : { pages: request.body.pages }),
        requestId: request.id,
      })

      return reply.code(201).send(document)
    },
  )

  typed.post(
    '/documents/upload',
    {
      schema: {
        tags: ['documents'],
        summary: 'Upload a source document',
        description:
          'Streams one file (PDF, PNG, or JPEG) into private storage. Metadata travels in the query string so the multipart body carries the file and nothing else. The declared content type is ignored; the file signature is checked instead.',
        querystring: uploadQuerySchema,
        consumes: ['multipart/form-data'],
        response: {
          201: documentSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const file = await request.file()

      if (file === undefined) {
        throw new ValidationError('A single file part is required.')
      }

      const document = await registerUploadedDocument(app.database, {
        user: actor(request),
        uploadDir: env.UPLOAD_DIR,
        maxBytes: env.UPLOAD_MAX_BYTES,
        stream: file.file,
        filename: file.filename,
        title: request.query.title,
        kind: request.query.kind,
        ...(request.query.reference === undefined
          ? {}
          : { reference: request.query.reference }),
        ...(request.query.status === undefined ? {} : { status: request.query.status }),
        // The transport truncates at its limit instead of throwing, so the
        // truncated flag is what tells the storage layer the file was cut off.
        // It is read *before* anything is stored: an over-limit upload must not
        // leave a document row or a file behind.
        isTruncated: () => file.file.truncated,
        requestId: request.id,
      })

      return reply.code(201).send(document)
    },
  )

  typed.get(
    '/documents/:documentId',
    {
      schema: {
        tags: ['documents'],
        summary: 'Read one source document',
        description:
          'A document belonging to somebody else is reported as `404`, identically to one that does not exist.',
        params: documentIdParams,
        response: {
          200: documentSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const document = await loadVisibleDocument(
        app.database,
        actor(request),
        request.params.documentId,
      )
      return reply.code(200).send(toDocumentView(document))
    },
  )

  typed.patch(
    '/documents/:documentId',
    {
      schema: {
        tags: ['documents'],
        summary: 'Update source document metadata',
        description:
          'Requires the `version` last read; a mismatch is a `409` rather than a silent overwrite. Only the owner or an administrator may change metadata.',
        params: documentIdParams,
        body: updateDocumentBodySchema,
        response: {
          200: documentSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const document = await updateDocument(app.database, {
        user: actor(request),
        documentId: request.params.documentId,
        version: request.body.version,
        ...(request.body.title === undefined ? {} : { title: request.body.title }),
        ...(request.body.reference === undefined
          ? {}
          : { reference: request.body.reference }),
        ...(request.body.pageCount === undefined
          ? {}
          : { pageCount: request.body.pageCount }),
        ...(request.body.status === undefined ? {} : { status: request.body.status }),
        requestId: request.id,
      })

      return reply.code(200).send(document)
    },
  )

  typed.get(
    '/documents/:documentId/pages',
    {
      schema: {
        tags: ['documents'],
        summary: 'List a document’s page references',
        description:
          'A `region` is present only when a provider actually reported one. The platform never estimates a bounding box, because an invented region would look like evidence.',
        params: documentIdParams,
        response: {
          200: z.object({ items: z.array(documentPageSchema) }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const items = await listDocumentPages(
        app.database,
        actor(request),
        request.params.documentId,
      )
      return reply.code(200).send({ items })
    },
  )

  typed.post(
    '/documents/:documentId/pages',
    {
      schema: {
        tags: ['documents'],
        summary: 'Record a page reference',
        description:
          'Records what the caller supplies. A region is stored only if it is given; nothing is inferred.',
        params: documentIdParams,
        body: addPageBodySchema,
        response: {
          201: documentPageSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const page = await addDocumentPage(app.database, {
        user: actor(request),
        documentId: request.params.documentId,
        pageNumber: request.body.pageNumber,
        ...(request.body.label === undefined ? {} : { label: request.body.label }),
        ...(request.body.width === undefined ? {} : { width: request.body.width }),
        ...(request.body.height === undefined ? {} : { height: request.body.height }),
        ...(request.body.region === undefined ? {} : { region: request.body.region }),
        requestId: request.id,
      })

      return reply.code(201).send(page)
    },
  )

  // Registered on the plain instance rather than the Zod-typed one.
  //
  // The success body is the stored file, streamed. A Zod response schema for
  // `200` would make Fastify run the JSON serializer over a stream, so this route
  // declares no success schema and lets Fastify pipe the bytes. The error
  // statuses are still documented, and they still go through the shared error
  // handler, which envelopes them. The consequence is that the generated
  // OpenAPI document does not describe the `200` body; that is recorded in the
  // README rather than papered over with a schema that would be false.
  app.get(
    '/documents/:documentId/file',
    {
      schema: {
        tags: ['documents'],
        summary: 'Download the stored file',
        description:
          'Access is checked before the file is opened. On success the response body is the raw stored bytes, with the sniffed content type and an attachment disposition; this route therefore has no JSON success schema.',
        params: documentIdParams,
        response: {
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      // `params` was already validated by the globally installed Zod validator
      // compiler before this handler ran. Parsing again here keeps the parameter
      // typed without a cast, because this route deliberately opts out of the
      // typed-response machinery.
      const { documentId } = documentIdParams.parse(request.params)

      const { stream, document } = await openDocumentFile(
        app.database,
        actor(request),
        documentId,
        env.UPLOAD_DIR,
      )

      return reply
        .header('content-type', document.contentType ?? 'application/octet-stream')
        .header('content-disposition', 'attachment')
        .header('x-content-type-options', 'nosniff')
        // Private evidence behind an authenticated route: it must not be kept by
        // a shared cache or written to a browser's disk cache.
        .header('cache-control', 'private, no-store')
        .send(stream)
    },
  )
}
