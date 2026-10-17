import { useSyncExternalStore } from "react"
import type { ReviewOutcomeResult } from "@/lib/api/types"

/*
  Reviewer decisions recorded in this browser tab only. Shared between the queue
  and the Evidence Desk so progress shows in both places. Nothing is persisted.
*/
let results: Record<string, ReviewOutcomeResult> = {}
const listeners = new Set<() => void>()

const emit = () => listeners.forEach((l) => l())

export function reviewKey(caseId: string, fieldId: string) {
  return `${caseId}:${fieldId}`
}

export function saveReviewResult(result: ReviewOutcomeResult) {
  results = { ...results, [reviewKey(result.caseId, result.fieldId)]: result }
  emit()
}

export function clearReviewResult(caseId: string, fieldId: string) {
  const { [reviewKey(caseId, fieldId)]: _removed, ...rest } = results
  results = rest
  emit()
}

export function useReviewResults(): Record<string, ReviewOutcomeResult> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => results,
  )
}
