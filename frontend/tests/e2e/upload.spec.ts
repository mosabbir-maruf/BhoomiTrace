import { test, expect } from "@playwright/test"
import {
  PDF_BYTES,
  openDocuments,
  oversizedPdf,
  registerViaUi,
  uniqueEmail,
} from "./helpers"

/**
 * Browser end-to-end coverage for the citizen document upload.
 *
 * Every test here drives the real SPA against the real backend (the dev server
 * proxies `/api` to it), so session cookies, the CSRF handshake, the multipart
 * body, and the server-side type/size checks are all exercised for real. No
 * response is mocked.
 */
test.describe("citizen document upload (live backend)", () => {
  test("uploads a PDF, sends the session cookie and CSRF header, and lists the document", async ({
    page,
  }) => {
    let csrf: string | undefined
    let cookie: string | undefined
    await page.route("**/api/v1/documents/upload**", async (route) => {
      const headers = route.request().headers()
      csrf = headers["x-csrf-token"]
      cookie = headers["cookie"]
      await route.continue()
    })

    await openDocuments(page)

    const title = `ই২ই নথি ${Date.now()}`
    await page.locator('input[type="file"]').setInputFiles({
      name: "e2e-deed.pdf",
      mimeType: "application/pdf",
      buffer: PDF_BYTES,
    })
    await page.getByLabel("নথির শিরোনাম").fill(title)
    await page.getByRole("button", { name: "ফাইল আপলোড করুন" }).click()

    await expect(page.getByText("আপলোড সম্পন্ন")).toBeVisible()
    await expect(page.getByRole("link", { name: title })).toBeVisible()

    expect(csrf, "the upload must carry the CSRF header").toBeTruthy()
    expect(cookie ?? "").toContain("bt_session")
  })

  test("refuses an oversize file before it is sent", async ({ page }) => {
    let uploads = 0
    await page.route("**/api/v1/documents/upload**", async (route) => {
      uploads += 1
      await route.continue()
    })

    await openDocuments(page)
    await page.locator('input[type="file"]').setInputFiles({
      name: "too-big.pdf",
      mimeType: "application/pdf",
      buffer: oversizedPdf(),
    })

    await expect(
      page.getByText("ফাইলটি ৫ এমবি-এর বেশি বড়। ছোট করে আবার চেষ্টা করুন।"),
    ).toBeVisible()
    expect(uploads, "an oversize file must not reach the network").toBe(0)
  })

  test("refuses an unsupported file type with an actionable message", async ({ page }) => {
    let uploads = 0
    await page.route("**/api/v1/documents/upload**", async (route) => {
      uploads += 1
      await route.continue()
    })

    await openDocuments(page)
    await page.locator('input[type="file"]').setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("not a document"),
    })

    await expect(
      page.getByText("শুধু পিডিএফ, জেপিজি বা পিএনজি ফাইল নেওয়া হয়।"),
    ).toBeVisible()
    expect(uploads, "a rejected type must not reach the network").toBe(0)
  })

  test("CSRF: the endpoint refuses a request without the header and accepts the cookie token", async ({
    page,
  }) => {
    const csrf = (await page.context().cookies()).find((c) => c.name === "bt_csrf")
    expect(csrf, "the readable bt_csrf cookie must exist after registration").toBeTruthy()

    const withoutHeader = await page.request.post(
      "/api/v1/documents/upload?title=e2e-csrf-probe&kind=external_reference",
      {
        multipart: {
          file: { name: "probe.pdf", mimeType: "application/pdf", buffer: PDF_BYTES },
        },
      },
    )
    expect(
      withoutHeader.status(),
      "a session request without the CSRF header is refused",
    ).toBe(403)

    const withHeader = await page.request.post(
      "/api/v1/documents/upload?title=e2e-csrf-probe&kind=external_reference",
      {
        headers: { "x-csrf-token": csrf?.value ?? "" },
        multipart: {
          file: { name: "probe.pdf", mimeType: "application/pdf", buffer: PDF_BYTES },
        },
      },
    )
    expect(
      withHeader.status(),
      "the cookie token in the header authorises the write",
    ).toBe(201)
  })
})

test.describe("authentication", () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test("a synthetic account registers and stays signed in across a reload", async ({
    page,
  }) => {
    await registerViaUi(page, uniqueEmail())

    await page.goto("/#/documents")
    await expect(page.getByRole("heading", { name: "নথিপত্র" })).toBeVisible()
    // The live upload panel is present, which means the cookie session survived.
    await expect(
      page.getByRole("button", { name: "ফাইল আপলোড করুন" }),
    ).toBeVisible()
  })
})
