/**
 * Shared value objects stored as `jsonb`.
 *
 * These are deliberately small and explicit: they describe data that an
 * extraction provider may or may not have reported, and every field is
 * optional so that "the provider did not say" is representable and distinct
 * from "the provider said zero".
 */

/**
 * A normalised region of a page, with `x`/`y` measured from the top-left and
 * all values in the range 0–1 of the page's width and height.
 *
 * Only ever populated from a provider's own output. Never synthesised to make a
 * record look more complete than it is.
 */
export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

/** A stable reference from a checklist item or finding to another record. */
export interface RecordReference {
  entityType: string
  entityId: string
  label?: string
}
