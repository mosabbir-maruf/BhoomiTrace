import { useState } from "react"
import {
  applicationStatusExplain,
  applicationStatusMeta,
  applicationStatusOrder,
} from "@/lib/domain"
import { formatNumber } from "@/lib/format"
import { routeHref } from "@/config/navigation"
import Button, { LinkButton } from "@/components/ui/Button"
import { SelectField, TextField } from "@/components/ui/Field"
import { Page } from "@/components/ui/Layout"
import { EmptyState } from "@/components/ui/States"
import StatusBadge from "@/components/ui/StatusBadge"
import { filterApplications, type StatusFilter } from "./filterApplications"
import { ApplicationList, WithApplicantData, crumbs } from "./shared"

const statusOptions = [
  { value: "all", label: "সব অবস্থা" },
  ...applicationStatusOrder.map((s) => ({
    value: s,
    label: applicationStatusMeta[s].label,
  })),
]

export default function ApplicationsPage() {
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<StatusFilter>("all")
  const filtered = query.trim() !== "" || status !== "all"
  const reset = () => {
    setQuery("")
    setStatus("all")
  }
  return (
    <Page
      title="আমার আবেদন"
      breadcrumbs={crumbs("applications")}
      description="প্রতিটি আবেদনের অবস্থা আর পরবর্তী ধাপ। বিস্তারিত দেখতে আবেদনে ক্লিক করুন।"
      actions={
        <LinkButton href={routeHref("new-application")} icon="plus">
          নতুন আবেদন শুরু করুন
        </LinkButton>
      }
    >
      <WithApplicantData>
        {(data) => {
          if (data.applications.length === 0)
            return (
              <EmptyState title="এখনো কোনো আবেদন করা হয়নি">
                “নতুন আবেদন শুরু করুন” বোতাম দিয়ে প্রথম আবেদন শুরু করুন।
              </EmptyState>
            )
          const visible = filterApplications(data.applications, query, status)
          return (
            <div className="space-y-8">
              <div>
                <form
                  role="search"
                  aria-label="আবেদন খুঁজুন"
                  className="mb-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem_auto] sm:items-end"
                  onSubmit={(e) => e.preventDefault()}
                >
                  <TextField
                    label="খুঁজুন"
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="ট্র্যাকিং নম্বর, মৌজা বা দাগ"
                    autoComplete="off"
                  />
                  <SelectField
                    label="অবস্থা"
                    value={status}
                    onChange={(e) => setStatus(e.target.value as StatusFilter)}
                    options={statusOptions}
                  />
                  <Button variant="ghost" onClick={reset} disabled={!filtered}>
                    খোঁজ মুছুন
                  </Button>
                </form>
                <p role="status" className="mb-3 text-sm text-ink-muted">
                  {formatNumber(data.applications.length)}টির মধ্যে{" "}
                  {formatNumber(visible.length)}টি আবেদন দেখানো হচ্ছে
                </p>
                {visible.length === 0 ? (
                  <EmptyState
                    title="এই খোঁজে কোনো আবেদন মেলেনি"
                    icon="search"
                    action={
                      <Button variant="secondary" onClick={reset}>
                        খোঁজ মুছে সব দেখুন
                      </Button>
                    }
                  >
                    বানান বা নম্বরটি আবার দেখুন, অথবা অবস্থা বদলান।
                  </EmptyState>
                ) : (
                  <ApplicationList applications={visible} today={data.today} />
                )}
              </div>

              <details className="rounded-md border border-rule bg-surface">
                <summary className="flex min-h-12 items-center px-5 font-semibold">
                  অবস্থার লেবেলগুলোর মানে
                </summary>
                <dl className="divide-y divide-rule border-t border-rule">
                  {applicationStatusOrder.map((s) => (
                    <div
                      key={s}
                      className="grid gap-2 px-5 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-start"
                    >
                      <dt>
                        <StatusBadge {...applicationStatusMeta[s]} />
                      </dt>
                      <dd>{applicationStatusExplain[s]}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            </div>
          )
        }}
      </WithApplicantData>
    </Page>
  )
}
