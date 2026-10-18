import { test, expect } from "@playwright/test"
import { openDocuments } from "./helpers"

/**
 * Live-versus-demo copy, checked in a real browser so the wording a user
 * actually sees is what is asserted.
 */
test.describe("live-mode messaging", () => {
  test("documents and new-application copy describes real, stored actions", async ({
    page,
  }) => {
    await openDocuments(page)
    await expect(
      page.getByText("আপনার আপলোড করা ও আবেদনের সঙ্গে যুক্ত নথি।"),
    ).toBeVisible()
    await expect(page.getByText(/সর্বোচ্চ ৫ এমবি/)).toBeVisible()
    await expect(page.getByText("ডেমো মোডে আপলোড বন্ধ")).toHaveCount(0)

    await page.goto("/#/new-application")
    await expect(
      page.getByText("শেষ ধাপে আবেদন সার্ভারে জমা হবে।"),
    ).toBeVisible()
  })
})

test.describe("demo-mode messaging", () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test("demo mode says uploads are unavailable and that nothing is submitted", async ({
    page,
  }) => {
    await page.goto("/#/demo/citizen")

    await page.goto("/#/documents")
    await expect(page.getByText("ডেমো মোডে আপলোড বন্ধ")).toBeVisible()

    await page.goto("/#/new-application")
    await expect(
      page.getByText("এটি ডেমো; শেষে কিছুই কোথাও জমা হবে না।"),
    ).toBeVisible()
  })
})
