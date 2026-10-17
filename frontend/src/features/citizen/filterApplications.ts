import type { ApplicationStatus, ApplicationSummary } from "@/lib/api/types"
import { toAsciiDigits } from "@/lib/format"

export type StatusFilter = ApplicationStatus | "all"

/** Matches tracking number, mouza or dag number; Bengali numerals in the query are accepted. */
export function filterApplications(
  applications: ApplicationSummary[],
  query: string,
  status: StatusFilter,
): ApplicationSummary[] {
  const needle = toAsciiDigits(query.trim()).toLowerCase()
  return applications.filter((application) => {
    if (status !== "all" && application.status !== status) return false
    if (!needle) return true
    return [
      application.trackingNumber ?? "",
      application.mouza,
      application.dagNumber,
    ].some((value) => value.toLowerCase().includes(needle))
  })
}
