const bengaliDigits = "০১২৩৪৫৬৭৮৯"

/** Renders ASCII digits in Bengali numerals, for record identifiers such as khatian and dag numbers. */
export function toBengaliDigits(value: string | number): string {
  return String(value).replace(
    /[0-9]/g,
    (digit) => bengaliDigits[Number(digit)],
  )
}

/** Normalises Bengali numerals typed into search fields back to ASCII. */
export function toAsciiDigits(value: string): string {
  return value.replace(/[০-৯]/g, (digit) =>
    String(bengaliDigits.indexOf(digit)),
  )
}

const numberFormat = new Intl.NumberFormat("bn-BD", {
  maximumFractionDigits: 2,
})
const dateFormat = new Intl.DateTimeFormat("bn-BD", {
  day: "numeric",
  month: "long",
  year: "numeric",
})
const dayFormat = new Intl.DateTimeFormat("bn-BD", { day: "numeric" })
const monthFormat = new Intl.DateTimeFormat("bn-BD", { month: "long" })

export function formatNumber(value: number): string {
  return numberFormat.format(value)
}

/** Parses an ISO date (YYYY-MM-DD) as a local calendar date, avoiding timezone drift. */
function parseDate(iso: string): Date {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number)
  return new Date(year, month - 1, day)
}

export function formatDate(iso: string): string {
  return dateFormat.format(parseDate(iso))
}

export function formatDateParts(iso: string): { day: string; month: string } {
  const date = parseDate(iso)
  return { day: dayFormat.format(date), month: monthFormat.format(date) }
}

export function formatShare(fraction: string): string {
  return fraction === "1/1" ? "সম্পূর্ণ" : `${toBengaliDigits(fraction)} অংশ`
}

/** Whole days from `today` to `iso`; negative when the date has passed. */
export function daysBetween(today: string, iso: string): number {
  const ms = parseDate(iso).getTime() - parseDate(today).getTime()
  return Math.round(ms / 86_400_000)
}

export function formatDaysLeft(today: string, iso: string): string {
  const days = daysBetween(today, iso)
  if (days < 0) return `সময় পেরিয়ে গেছে (${formatNumber(-days)} দিন আগে)`
  if (days === 0) return "আজ শেষ দিন"
  return `আর ${formatNumber(days)} দিন বাকি`
}
