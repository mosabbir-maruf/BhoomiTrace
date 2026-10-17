import { useState } from "react"
import type {
  ActionItem,
  ApplicantDashboard,
  ApplicationSummary,
} from "@/lib/api/types"
import {
  actionKindMeta,
  applicationStatusMeta,
  applicationStatusOrder,
  applicationTypeLabel,
  isActiveStatus,
  surveyLabel,
} from "@/lib/domain"
import {
  daysBetween,
  formatDate,
  formatDaysLeft,
  formatNumber,
  formatShare,
  toBengaliDigits,
} from "@/lib/format"
import { routeHref } from "@/config/navigation"
import Button, { LinkButton } from "@/components/ui/Button"
import { SelectField, TextField } from "@/components/ui/Field"
import { Page, Section } from "@/components/ui/Layout"
import { EmptyState } from "@/components/ui/States"
import StatusBadge from "@/components/ui/StatusBadge"
import { filterApplications, type StatusFilter } from "./filterApplications"
import { ApplicationList, WithApplicantData } from "./shared"

/* ---------- Quiet summary: three numbers in one line, no cards ---------- */

function Summary({ data }: { data: ApplicantDashboard }) {
  const active = data.applications.filter((a) =>
    isActiveStatus(a.status),
  ).length
  const totalArea = data.parcels.reduce((sum, p) => sum + p.areaDecimal, 0)
  const items: { label: string; value: number; unit?: string }[] = [
    { label: "চলমান আবেদন", value: active },
    { label: "আপনার করণীয়", value: data.actionItems.length },
    { label: "যুক্ত খতিয়ান", value: data.parcels.length },
    { label: "মোট জমি", value: totalArea, unit: "শতাংশ" },
  ]
  return (
    <div className="mb-10">
      {/* Ledger-style double rule closing the page header, as in the approved design. */}
      <hr className="mb-10 h-[4px] border-y border-x-0 border-[#a9bfa6] bg-transparent" />
      <dl className="grid grid-cols-2 overflow-hidden rounded-sm border border-rule bg-surface md:grid-cols-4">
        {items.map((item, i) => (
          <div
            key={item.label}
            className={`flex flex-col-reverse justify-end px-5 py-5 sm:px-6 ${
              i % 2 === 1 ? "border-l border-rule" : ""
            } ${i >= 2 ? "border-t border-rule md:border-t-0" : ""} ${
              i === 2 ? "md:border-l" : ""
            }`}
          >
            <dt className="mt-1 text-sm text-ink-muted">{item.label}</dt>
            <dd className="font-display text-[2rem] leading-tight font-semibold text-ink tabular">
              {formatNumber(item.value)}
              {item.unit && (
                <span className="ml-1.5 font-sans text-base font-normal text-ink-muted">
                  {item.unit}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/* ---------- 1. এখন আপনার করণীয় ---------- */

interface Task {
  id: string
  title: string
  reference: string
  explanation: string
  due: string | null
  overdue: boolean
  action: { label: string; href: string }
}

function actionFor(item: ActionItem) {
  return item.kind === "document"
    ? {
        label: "কোন নথি লাগবে দেখুন",
        href: routeHref("application", item.applicationId),
      }
    : {
        label: "শুনানির বিস্তারিত দেখুন",
        href: routeHref("application", item.applicationId),
      }
}

function buildTasks(data: ApplicantDashboard): Task[] {
  const ref = (id: string) => {
    const app = data.applications.find((a) => a.id === id)
    return app
      ? `${applicationTypeLabel[app.type]}, ${app.trackingNumber ?? "খসড়া"}`
      : ""
  }
  const dated = [...data.actionItems]
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .map((item): Task => {
      const overdue = daysBetween(data.today, item.dueDate) < 0
      return {
        id: item.id,
        title: item.title,
        reference: ref(item.applicationId),
        explanation: overdue
          ? `${item.detail} শেষ তারিখ পেরিয়ে গেছে; কী করতে হবে জানতে ভূমি অফিসে যোগাযোগ করুন।`
          : item.detail,
        due: item.dueDate,
        overdue,
        action: actionFor(item),
      }
    })
  const drafts = data.applications
    .filter((a) => a.status === "draft")
    .map(
      (a): Task => ({
        id: a.id,
        title: `অসম্পূর্ণ খসড়া: ${applicationTypeLabel[a.type]}`,
        reference: `${a.mouza} মৌজা, দাগ ${toBengaliDigits(a.dagNumber)}`,
        explanation: a.nextStep ?? "আবেদনটি এখনো জমা হয়নি।",
        due: null,
        overdue: false,
        action: {
          label: "আবেদন সম্পূর্ণ করুন",
          href: routeHref("continue-application", a.id),
        },
      }),
    )
  // Overdue first (most urgent), then upcoming by date, then undated drafts.
  return [
    ...dated.filter((t) => t.overdue),
    ...dated.filter((t) => !t.overdue),
    ...drafts,
  ]
}

function TaskList({ data, tasks }: { data: ApplicantDashboard; tasks: Task[] }) {
  if (tasks.length === 0)
    return (
      <EmptyState title="এই মুহূর্তে আপনার কোনো করণীয় নেই" icon="check">
        কোনো আবেদনে নথি বা শুনানির দরকার হলে এখানে তারিখসহ দেখাবে।
      </EmptyState>
    )
  return (
    <ul className="divide-y divide-rule rounded-md border border-rule bg-surface">
      {tasks.map((task) => (
        <li
          key={task.id}
          className={`grid gap-4 px-5 py-5 md:grid-cols-[minmax(0,1fr)_14rem] md:gap-8 ${
            task.overdue ? "border-l-4 border-l-danger" : ""
          }`}
        >
          <div className="min-w-0">
            <h3 className="text-lg font-semibold">{task.title}</h3>
            <p className="text-sm text-ink-muted tabular">{task.reference}</p>
            <p className="mt-2 max-w-[65ch]">{task.explanation}</p>
          </div>
          <div className="flex flex-col items-start gap-3 md:items-end md:text-right">
            {task.due ? (
              <div>
                <p className="text-sm text-ink-muted">শেষ তারিখ</p>
                <p className="font-semibold">{formatDate(task.due)}</p>
                {task.overdue ? (
                  <StatusBadge
                    tone="danger"
                    icon="alert"
                    label={formatDaysLeft(data.today, task.due)}
                  />
                ) : (
                  <p className="text-sm font-medium text-warning">
                    {formatDaysLeft(data.today, task.due)}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-ink-muted">কোনো শেষ তারিখ নেই</p>
            )}
            <LinkButton href={task.action.href} variant="secondary" size="sm">
              {task.action.label}
              <span className="sr-only">: {task.title}</span>
            </LinkButton>
          </div>
        </li>
      ))}
    </ul>
  )
}

/* ---------- 2. আমার আবেদন ---------- */

const statusOptions = [
  { value: "all", label: "সব অবস্থা" },
  ...applicationStatusOrder.map((s) => ({
    value: s,
    label: applicationStatusMeta[s].label,
  })),
]

function Applications({
  applications,
  today,
}: {
  applications: ApplicationSummary[]
  today: string
}) {
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<StatusFilter>("all")
  const visible = filterApplications(applications, query, status)
  const clear = () => {
    setQuery("")
    setStatus("all")
  }

  if (applications.length === 0)
    return (
      <EmptyState title="এখনো কোনো আবেদন করা হয়নি">
        ওপরের “নতুন আবেদন শুরু করুন” বোতাম দিয়ে নামজারি, খতিয়ান সংশোধন বা সার্টিফাইড কপির
        আবেদন শুরু করতে পারেন।
      </EmptyState>
    )

  return (
    <>
      <form
        role="search"
        aria-label="আবেদন খুঁজুন"
        className="mb-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]"
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
      </form>
      <p role="status" className="mb-3 text-sm text-ink-muted">
        {formatNumber(applications.length)}টির মধ্যে{" "}
        {formatNumber(visible.length)}টি আবেদন দেখানো হচ্ছে
      </p>
      {visible.length === 0 ? (
        <EmptyState
          title="এই খোঁজে কোনো আবেদন মেলেনি"
          icon="search"
          action={
            <Button variant="secondary" onClick={clear}>
              খোঁজ মুছে সব দেখুন
            </Button>
          }
        >
          বানান বা নম্বরটি আবার দেখুন, অথবা অবস্থা বদলান।
        </EmptyState>
      ) : (
        <ApplicationList applications={visible} today={today} />
      )}
    </>
  )
}

/* ---------- 3. আমার জমির রেকর্ড ---------- */

function Records({ data }: { data: ApplicantDashboard }) {
  if (data.parcels.length === 0)
    return (
      <EmptyState title="কোনো জমির রেকর্ড যুক্ত নেই" icon="map">
        আবেদন অনুমোদিত হলে সংশ্লিষ্ট খতিয়ান এখানে দেখাবে।
      </EmptyState>
    )
  return (
    <ul className="divide-y divide-rule rounded-md border border-rule bg-surface">
      {data.parcels.map((p) => {
        const fields: [string, string][] = [
          ["মৌজা", p.mouza],
          ["দাগ", p.dagNumbers.map(toBengaliDigits).join(", ")],
          ["জমির পরিমাণ", `${formatNumber(p.areaDecimal)} শতাংশ`],
          ["আপনার অংশ", formatShare(p.ownershipShare)],
          ["জরিপ", surveyLabel[p.survey]],
        ]
        return (
          <li
            key={p.id}
            className="grid gap-3 px-5 py-4 lg:grid-cols-[10rem_minmax(0,1fr)] lg:items-baseline lg:gap-6"
          >
            <h3 className="font-semibold">
              <a
                href={routeHref("record", p.id)}
                className="text-accent underline decoration-accent/30 underline-offset-4 hover:decoration-accent"
              >
                খতিয়ান {toBengaliDigits(p.khatianNumber)}
              </a>
              <span className="block text-sm font-normal text-ink-muted">
                {p.upazila}, {p.district}
              </span>
            </h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
              {fields.map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-sm text-ink-muted">{label}</dt>
                  <dd className="break-words">{value}</dd>
                </div>
              ))}
            </dl>
          </li>
        )
      })}
    </ul>
  )
}

/* ---------- Page ---------- */

export default function Dashboard() {
  return (
    <Page
      title="আমার ড্যাশবোর্ড"
      description="আপনার আবেদনের অবস্থা, জমির রেকর্ড আর সামনের তারিখগুলো এক পাতায়।"
      actions={
        <LinkButton
          href={routeHref("new-application")}
          icon="plus"
          className="rounded-[3px] font-semibold"
        >
          নতুন আবেদন শুরু করুন
        </LinkButton>
      }
    >
      <WithApplicantData>
        {(data) => {
          const tasks = buildTasks(data)
          return (
            <>
              <Summary data={data} />
              <div className="space-y-12">
                <Section
                  title="এখন আপনার করণীয়"
                  description={`আজকের তারিখ (ডেমো): ${formatDate(data.today)}`}
                >
                  <TaskList data={data} tasks={tasks} />
                </Section>

                <Section
                  title="আমার আবেদন"
                  description="সর্বশেষ হালনাগাদসহ সব আবেদন"
                >
                  <Applications
                    applications={data.applications}
                    today={data.today}
                  />
                </Section>

                <Section
                  title="আমার জমির রেকর্ড"
                  description="আপনার নামে যুক্ত খতিয়ানের সংক্ষিপ্ত তথ্য"
                  actions={
                    <a href={routeHref("records")} className="text-link">
                      সব রেকর্ড দেখুন
                    </a>
                  }
                >
                  <Records data={data} />
                </Section>

                <nav
                  aria-label="আরও দেখুন"
                  className="flex flex-wrap gap-x-6 pt-2"
                >
                  <a href={routeHref("documents")} className="text-link">
                    আমার নথিপত্র
                  </a>
                  <a href={routeHref("help")} className="text-link">
                    সহায়তা ও শব্দের অর্থ
                  </a>
                </nav>
              </div>
            </>
          )
        }}
      </WithApplicantData>
    </Page>
  )
}
