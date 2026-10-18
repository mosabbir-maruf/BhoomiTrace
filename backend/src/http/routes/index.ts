import type { FastifyInstance } from 'fastify'

import { auditRoutes } from './audit.js'
import { applicationRoutes } from './applications.js'
import { authRoutes } from './auth.js'
import { documentRoutes } from './documents.js'
import { jobRoutes } from './jobs.js'
import { lineageRoutes } from './lineage.js'
import { parcelRoutes } from './parcels.js'
import { readinessRoutes } from './readiness.js'
import { reviewRoutes } from './review.js'

/**
 * Every versioned API route module, in one place.
 *
 * Registration order is not load-bearing — Fastify's router matches on path and
 * method, not on insertion order — but keeping the list explicit means a new
 * module cannot be forgotten, and it is obvious where the `/api/v1` surface is
 * assembled.
 */
export function registerApiRoutes(app: FastifyInstance): void {
  authRoutes(app)
  parcelRoutes(app)
  applicationRoutes(app)
  lineageRoutes(app)
  documentRoutes(app)
  reviewRoutes(app)
  readinessRoutes(app)
  jobRoutes(app)
  auditRoutes(app)
}
