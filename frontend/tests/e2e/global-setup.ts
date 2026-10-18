import { request } from "@playwright/test"
import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { E2E_PASSWORD, E2E_STORAGE_STATE, uniqueEmail } from "./helpers"

/**
 * Registers one synthetic account per run and stores its session for the
 * signed-in specs.
 *
 * Registration happens through the real API rather than the UI so a single
 * account serves every signed-in test: the auth rate limit is per-client, and
 * one registration keeps a full run well inside it. The email is unique so runs
 * never collide, and it is synthetic — no real identity is involved.
 */
export default async function globalSetup() {
  const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173"
  const context = await request.newContext({ baseURL })

  const response = await context.post("/api/v1/auth/register", {
    data: {
      email: uniqueEmail(),
      displayName: "ই২ই পরীক্ষা",
      password: E2E_PASSWORD,
    },
  })

  if (!response.ok()) {
    const body = await response.text()
    await context.dispose()
    throw new Error(
      `E2E setup could not register a synthetic account (status ${response.status()}): ${body}\n` +
        "Is the backend running and reachable at E2E_API_URL?",
    )
  }

  const path = resolve(E2E_STORAGE_STATE)
  await mkdir(dirname(path), { recursive: true })
  await context.storageState({ path })
  await context.dispose()
}
