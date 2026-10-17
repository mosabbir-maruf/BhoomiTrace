import { useEffect, useRef, useState } from "react"
import {
  isLiveData,
  setSession,
  signOut,
  startDemo,
  useDataSourceKey,
  useSession,
} from "@/lib/api/session"
import { routeHref } from "@/config/navigation"
import { navigate, useRoute } from "@/hooks/useHashRoute"
import {
  mockScenarios,
  setMockScenario,
  type MockScenario,
} from "@/mocks/service"
import Button from "@/components/ui/Button"
import { SelectField, TextField } from "@/components/ui/Field"
import { Page, Panel, Section } from "@/components/ui/Layout"
import { Notice } from "@/components/ui/States"
import { crumbs } from "./shared"

const scenarioLabel: Record<MockScenario, string> = {
  normal: "স্বাভাবিক",
  slow: "ধীর সংযোগ",
  empty: "কোনো তথ্য নেই",
  error: "সংযোগ ত্রুটি",
}

export default function ProfilePage() {
  const session = useSession()
  const { query } = useRoute()
  const scenario = useDataSourceKey() as MockScenario
  const [name, setName] = useState(session?.displayName ?? "")
  const [nameError, setNameError] = useState("")
  const [saved, setSaved] = useState(false)
  const settingsRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (query.get("section") === "settings")
      settingsRef.current?.scrollIntoView({ block: "start" })
  }, [query])

  if (!session) return null
  const roleText =
    session.role === "citizen"
      ? "নমুনা আবেদনকারী (নাগরিক ডেমো)"
      : "নমুনা পর্যালোচক (পর্যালোচক ডেমো)"
  const other = session.role === "citizen" ? "reviewer" : "citizen"

  return (
    <Page
      title="আমার প্রোফাইল"
      breadcrumbs={crumbs("profile")}
      description="কাল্পনিক ডেমো অ্যাকাউন্ট। কোনো আসল অ্যাকাউন্ট বা স্থায়ী প্রোফাইল নেই।"
    >
      <div className="max-w-2xl space-y-10">
        <Section title="অ্যাকাউন্ট">
          <Panel>
            <dl className="divide-y divide-rule">
              <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-4 px-5 py-3">
                <dt className="text-ink-muted">অ্যাকাউন্ট আইডি</dt>
                <dd lang="en">{session.accountId}</dd>
              </div>
              <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-4 px-5 py-3">
                <dt className="text-ink-muted">ভূমিকা</dt>
                <dd>{roleText}</dd>
              </div>
              <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-4 px-5 py-3">
                <dt className="text-ink-muted">ভাষা</dt>
                <dd>বাংলা (ডেমোতে এখন শুধু বাংলা আছে)</dd>
              </div>
            </dl>
          </Panel>
          <form
            className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault()
              if (name.trim().length < 2) {
                setNameError("অন্তত দুই অক্ষরের নাম লিখুন।")
                setSaved(false)
                return
              }
              setNameError("")
              setSession({ ...session, displayName: name.trim() })
              setSaved(true)
            }}
          >
            <TextField
              label="দেখানোর নাম"
              hint="শুধু এই ট্যাবে বদলায়। আসল নাম দেওয়ার দরকার নেই।"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setSaved(false)
              }}
              error={nameError}
              containerClassName="flex-1"
            />
            <Button type="submit" variant="secondary">
              নাম বদলান
            </Button>
          </form>
          {saved && (
            <div className="mt-3">
              <Notice tone="success" title="নাম বদলানো হয়েছে (শুধু এই ডেমোতে)" />
            </div>
          )}
        </Section>

        <section
          ref={settingsRef}
          aria-labelledby="settings-h"
          className="scroll-mt-24"
        >
          <h2 id="settings-h" className="mb-3 text-xl font-semibold">
            ডেমো সেটিংস
          </h2>
          <Panel className="space-y-6 p-5">
            {!isLiveData && (
              <div className="max-w-xs">
                <SelectField
                  label="নমুনা তথ্যের অবস্থা"
                  hint="ধীর সংযোগ, খালি তথ্য বা ত্রুটির পাতা কেমন দেখায় তা দেখতে।"
                  value={scenario}
                  onChange={(e) =>
                    setMockScenario(e.target.value as MockScenario)
                  }
                  options={mockScenarios.map((s) => ({
                    value: s,
                    label: scenarioLabel[s],
                  }))}
                />
              </div>
            )}
            <div>
              <p className="font-medium">ভূমিকা বদলান</p>
              <p className="mb-2 text-sm text-ink-muted">
                ডেমোর সুবিধার জন্য। এটি কোনো নিরাপত্তা ব্যবস্থা নয়।
              </p>
              <Button
                variant="secondary"
                onClick={() => {
                  startDemo(other)
                  navigate(
                    routeHref(other === "citizen" ? "dashboard" : "queue"),
                  )
                }}
              >
                {other === "reviewer" ? "পর্যালোচক ডেমোতে যান" : "নাগরিক ডেমোতে যান"}
              </Button>
            </div>
            <div className="border-t border-rule pt-5">
              <Button
                icon="logout"
                onClick={() => {
                  signOut()
                  navigate(routeHref("login", undefined, { signedOut: "1" }))
                }}
              >
                লগআউট
              </Button>
            </div>
          </Panel>
        </section>
      </div>
    </Page>
  )
}
