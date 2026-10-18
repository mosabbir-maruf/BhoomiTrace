import { expect, type Page } from "@playwright/test"

/** Synthetic sign-in material. Not a real credential and never reused elsewhere. */
export const E2E_PASSWORD = "E2eSyntheticPass123!"

/** Where the signed-in session is cached between global setup and the specs. */
export const E2E_STORAGE_STATE = ".auth/e2e-user.json"

/** A minimal, signature-valid PDF. The backend sniffs `%PDF-` and nothing more. */
export const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
  "utf8",
)

/** A file just over the configured 5 MiB cap, for the size-limit test. */
export function oversizedPdf(): Buffer {
  return Buffer.alloc(5 * 1024 * 1024 + 1, 0x41)
}

/** A non-unique, synthetic email so a run never collides with another. */
export function uniqueEmail(): string {
  return `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`
}

/** Registers a synthetic account through the real UI and waits for confirmation. */
export async function registerViaUi(page: Page, email: string): Promise<void> {
  await page.goto("/#/register")
  await page.getByLabel("আপনার নাম (পূর্ণ বা প্রদর্শনের নাম)").fill("ই২ই পরীক্ষা")
  await page.getByLabel("ইমেইল ঠিকানা").fill(email)
  await page.getByLabel("পাসওয়ার্ড", { exact: true }).fill(E2E_PASSWORD)
  await page.getByLabel("পাসওয়ার্ড আবার লিখুন").fill(E2E_PASSWORD)
  await page.getByRole("checkbox").check()
  await page.getByRole("button", { name: "অ্যাকাউন্ট তৈরি করুন" }).click()
  await expect(page.getByText("অ্যাকাউন্ট তৈরি হয়েছে", { exact: true })).toBeVisible()
}

/** Opens the documents page and waits for its heading. */
export async function openDocuments(page: Page): Promise<void> {
  await page.goto("/#/documents")
  await expect(page.getByRole("heading", { name: "নথিপত্র" })).toBeVisible()
}
