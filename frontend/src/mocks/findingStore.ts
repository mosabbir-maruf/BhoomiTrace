import { useSyncExternalStore } from "react"
import type { FindingReviewAction } from "@/lib/api/types"

export interface FindingDecisionEntry {
  action: FindingReviewAction
  reason?: string
  updatedAt: string
}

let decisions: Record<string, FindingDecisionEntry> = {}
const listeners = new Set<() => void>()

const emit = () => listeners.forEach((l) => l())

export function saveFindingDecision(
  findingId: string,
  action: FindingReviewAction,
  reason?: string,
) {
  decisions = {
    ...decisions,
    [findingId]: {
      action,
      reason,
      updatedAt: new Date().toISOString().slice(0, 10),
    },
  }
  emit()
}

export function resetFindingDecisions() {
  decisions = {}
  emit()
}

export function useFindingDecisions(): Record<string, FindingDecisionEntry> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => decisions,
  )
}
