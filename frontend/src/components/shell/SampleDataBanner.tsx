import { useDataSourceKey } from "@/lib/api/session"
import {
  mockScenarios,
  setMockScenario,
  type MockScenario,
} from "@/mocks/service"

const scenarioLabel: Record<MockScenario, string> = {
  normal: "স্বাভাবিক",
  slow: "ধীর সংযোগ",
  empty: "কোনো তথ্য নেই",
  error: "সংযোগ ত্রুটি",
}

/** Shown only in mock mode, so sample data is never mistaken for real records. */
export default function SampleDataBanner() {
  const scenario = useDataSourceKey() as MockScenario
  return (
    <div className="border-b border-warning/25 bg-warning-soft text-sm text-ink">
      <div className="page-width flex flex-col gap-2 py-2 md:flex-row md:items-center md:justify-between">
        <p>
          <strong className="font-semibold text-warning">ডেমো:</strong> সব নাম,
          নম্বর ও আবেদন কাল্পনিক। কোনো সরকারি ব্যবস্থার সঙ্গে সংযোগ নেই।
        </p>
        <label className="flex shrink-0 items-center gap-2">
          <span className="text-ink-muted">পরীক্ষার অবস্থা</span>
          <select
            value={scenario}
            onChange={(event) =>
              setMockScenario(event.target.value as MockScenario)
            }
            className="min-h-11 rounded-sm border border-field bg-surface px-2 text-sm"
          >
            {mockScenarios.map((value) => (
              <option key={value} value={value}>
                {scenarioLabel[value]}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}
