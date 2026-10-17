import test from "node:test"
import assert from "node:assert/strict"
import { apiGet, apiPost, ApiError, API_BASE_URL } from "../src/lib/api/client.ts"
import { login, register } from "../src/lib/api/auth.ts"
import { submitApplication } from "../src/lib/api/applications.ts"
import { setSession } from "../src/lib/api/session.ts"

test("API Client: Default API_BASE_URL is relative when VITE_API_URL is unset", () => {
  // Unset VITE_API_URL must result in empty string base URL for Vite dev proxy forwarding
  assert.strictEqual(typeof API_BASE_URL, "string")
  assert.strictEqual(API_BASE_URL, "")
})

test("Auth Contract: login sends exact email and password payload", async () => {
  const originalFetch = globalThis.fetch
  let capturedUrl = ""
  let capturedInit: RequestInit | undefined

  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input)
    capturedInit = init
    return new Response(
      JSON.stringify({
        user: {
          id: "00000000-0000-0000-0000-000000000001",
          email: "citizen@example.com",
          displayName: "রহিমা বেগম",
          role: "applicant",
          status: "active",
          createdAt: new Date().toISOString(),
        },
        csrfToken: "test-csrf-token",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }

  try {
    setSession(null)
    const session = await login({
      email: "citizen@example.com",
      password: "StrongPassword123!",
    })

    assert.strictEqual(capturedUrl, "/api/v1/auth/login")
    assert.strictEqual(capturedInit?.method, "POST")
    const sentBody = JSON.parse(String(capturedInit?.body))
    assert.deepStrictEqual(sentBody, {
      email: "citizen@example.com",
      password: "StrongPassword123!",
    })
    // Ensure no unsupported properties were sent
    assert.strictEqual("identifier" in sentBody, false)
    assert.strictEqual("phone" in sentBody, false)
    assert.strictEqual("role" in sentBody, false)

    assert.strictEqual(session.displayName, "রহিমা বেগম")
    assert.strictEqual(session.role, "citizen")
    assert.strictEqual(session.isDemo, false)
  } finally {
    globalThis.fetch = originalFetch
    setSession(null)
  }
})

test("Auth Contract: register sends exact email, displayName, and password payload", async () => {
  const originalFetch = globalThis.fetch
  let capturedUrl = ""
  let capturedInit: RequestInit | undefined

  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input)
    capturedInit = init
    return new Response(
      JSON.stringify({
        user: {
          id: "00000000-0000-0000-0000-000000000002",
          email: "newuser@example.com",
          displayName: "করিম মিয়া",
          role: "applicant",
          status: "active",
          createdAt: new Date().toISOString(),
        },
        csrfToken: "test-csrf-token-reg",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    )
  }

  try {
    setSession(null)
    const session = await register({
      email: "newuser@example.com",
      displayName: "করিম মিয়া",
      password: "ValidPassword123!",
    })

    assert.strictEqual(capturedUrl, "/api/v1/auth/register")
    assert.strictEqual(capturedInit?.method, "POST")
    const sentBody = JSON.parse(String(capturedInit?.body))
    assert.deepStrictEqual(sentBody, {
      email: "newuser@example.com",
      displayName: "করিম মিয়া",
      password: "ValidPassword123!",
    })
    // Ensure no unsupported properties were sent
    assert.strictEqual("fullName" in sentBody, false)
    assert.strictEqual("phone" in sentBody, false)
    assert.strictEqual("nationalId" in sentBody, false)
    assert.strictEqual("role" in sentBody, false)

    assert.strictEqual(session.displayName, "করিম মিয়া")
    assert.strictEqual(session.role, "citizen")
  } finally {
    globalThis.fetch = originalFetch
    setSession(null)
  }
})

test("Response Handling: 204 No Content resolves to null without JSON parsing error", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 204 })

  try {
    const result = await apiPost<void>("/api/v1/auth/logout")
    assert.strictEqual(result, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Error Handling: Nested backend error envelope is properly parsed into ApiError", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "validation_failed",
          message: "The request failed validation.",
          requestId: "req-bt-test-99",
          details: [{ path: "/password", message: "Too short" }],
        },
      }),
      { status: 422, headers: { "content-type": "application/json" } },
    )

  try {
    await assert.rejects(
      async () => {
        await apiPost("/api/v1/auth/register", { email: "a@b.com" })
      },
      (err: unknown) => {
        assert.ok(err instanceof ApiError)
        assert.strictEqual(err.status, 422)
        assert.strictEqual(err.code, "validation_failed")
        assert.strictEqual(err.message, "The request failed validation.")
        assert.strictEqual(err.requestId, "req-bt-test-99")
        assert.deepStrictEqual(err.details, [
          { path: "/password", message: "Too short" },
        ])
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Live Mode Protection: Live API errors throw ApiError and never silently return mock data", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "unauthenticated",
          message: "Authentication required.",
          requestId: "req-err-401",
        },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    )

  try {
    setSession(null) // Unauthenticated live mode

    // 1. Login failure throws ApiError
    await assert.rejects(
      async () => {
        await login({ email: "nonexistent@example.com", password: "badpassword123" })
      },
      (err: unknown) => {
        assert.ok(err instanceof ApiError)
        assert.strictEqual(err.status, 401)
        assert.strictEqual(err.code, "unauthenticated")
        return true
      },
    )

    // 2. Application submission failure throws ApiError
    await assert.rejects(
      async () => {
        await submitApplication({
          type: "mutation",
          district: "ঢাকা",
          upazila: "সাভার",
          mouza: "ধামরাই",
          khatianNumber: "123",
          dagNumber: "456",
          documents: ["deed"],
          termsAccepted: true,
        })
      },
      (err: unknown) => {
        assert.ok(err instanceof ApiError)
        assert.strictEqual(err.status, 401)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
    setSession(null)
  }
})
