/**
 * Barrel module for the database schema.
 *
 * Drizzle Kit reads this file, so every table must be re-exported here.
 *
 * ## Deletion policy
 *
 * `review_decisions` and `audit_events` are append-only, and PostgreSQL enforces
 * that with triggers. A referential action that would rewrite or remove one of
 * their rows therefore cannot be allowed, or the two mechanisms would contradict
 * each other. The resulting policy is:
 *
 * - Every foreign key held by an append-only table is `ON DELETE RESTRICT`, and
 *   nothing references an append-only table with `CASCADE` or `SET NULL`.
 * - Records that carry history (`users`, `parcels`) are never hard-deleted.
 *   Accounts are deactivated with `users.status = 'suspended'`; parcels are
 *   retained as records. Hard deletion is reserved for records without history.
 * - Owned attributes with no independent meaning (`parcel_dags`) cascade with
 *   their parent.
 * - Derived data a reviewer has not yet acted on (`extractions`, `findings`)
 *   cascades with its parcel. Once review history exists, that cascade is
 *   blocked by the `RESTRICT` keys above, so history always wins.
 * - **Evidence is retained too.** An extraction is the record of where a value
 *   came from, so `extractions.source_document_id` is `ON DELETE RESTRICT`: a
 *   source document that an extraction points at cannot be hard-deleted. A
 *   `SET NULL` action would leave the extraction in place with its provenance
 *   erased — the value would appear to have come from nowhere. The column stays
 *   nullable so a manual-entry extraction can exist with no document at all.
 * - `audit_events.entity_type` / `entity_id` are intentionally *not* foreign
 *   keys: an audit entry records what happened and must outlive the entity it
 *   describes.
 * - Operational tables that carry no history (`auth_sessions`,
 *   `document_pages`, `readiness_checklist_items`) cascade from their parent.
 *   Losing a session, a page, or a checklist row destroys no evidence: a
 *   document whose pages could be lost this way is already undeletable, because
 *   `extractions.source_document_id` restricts it.
 * - Work and report tables (`processing_jobs`, `readiness_reports`) restrict
 *   their parcel and document references, so an operational record never
 *   outlives an explanation of what it was about.
 */

export * from './enums.js'
export * from './types.js'
export * from './users.js'
export * from './sessions.js'
export * from './parcels.js'
export * from './applications.js'
export * from './lineage.js'
export * from './documents.js'
export * from './pages.js'
export * from './extractions.js'
export * from './findings.js'
export * from './reviews.js'
export * from './audit.js'
export * from './jobs.js'
export * from './readiness.js'
