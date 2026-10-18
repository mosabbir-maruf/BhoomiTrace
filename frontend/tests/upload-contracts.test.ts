import test from "node:test"
import assert from "node:assert/strict"
import {
  ApiError,
  setCsrfToken,
  setUploadTransportFactoryForTests,
} from "../src/lib/api/client.ts"
import {
  ALLOWED_UPLOAD_ACCEPT,
  UPLOAD_DOCUMENT_KIND,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_LABEL,
  describeUploadError,
  uploadDocument,
  validateUploadFile,
} from "../src/lib/api/documents.ts"
import { sessionFromUser, setSession } from "../src/lib/api/session.ts"
import { recordReviewOutcome } from "../src/lib/api/review.ts"

/* -------------------------------------------------------------------------- */
/* A minimal XMLHttpRequest stand-in for the upload transport                  */
/* -------------------------------------------------------------------------- */

interface FakeTransport {
  method: string
  url: string
  headers: Record<string, string>
  responseHeaders: Record<string, string>
  withCredentials: boolean
  status: number
  statusText: string
  responseText: string
  sentBody: unknown
  upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null }
  onload: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
  ontimeout: (() => void) | null
  open(method: string, url: string): void
  setRequestHeader(name: string, value: string): void
  getResponseHeader(name: string): string | null
  send(body: unknown): void
  abort(): void
}

/**
 * Installs a transport that answers every upload with `reply`. Returns the last
 * transport the client built so the test can inspect the wire-level request.
 */
function stubUpload(reply: {
  status: number
  body?: string
  statusText?: string
  headers?: Record<string, string>
  progress?: { loaded: number; total: number }
}): { last: () => FakeTransport; built: () => number } {
  let last: FakeTransport | null = null
  let built = 0
  setUploadTransportFactoryForTests(() => {
    built += 1
    const t: FakeTransport = {
      method: "",
      url: "",
      headers: {},
      responseHeaders: reply.headers ?? {},
      withCredentials: false,
      status: 0,
      statusText: "",
      responseText: "",
      sentBody: null,
      upload: { onprogress: null },
      onload: null,
      onerror: null,
      onabort: null,
      ontimeout: null,
      open(method, url) {
        t.method = method
        t.url = url
      },
      setRequestHeader(name, value) {
        t.headers[name.toLowerCase()] = value
      },
      getResponseHeader(name) {
        return t.responseHeaders[name.toLowerCase()] ?? null
      },
      send(body) {
        t.sentBody = body
        if (reply.progress && t.upload.onprogress) {
          t.upload.onprogress({
            loaded: reply.progress.loaded,
            total: reply.progress.total,
            lengthComputable: true,
          })
        }
        t.status = reply.status
        t.statusText = reply.statusText ?? ""
        t.responseText = reply.body ?? ""
        t.onload?.()
      },
      abort() {
        t.onabort?.()
      },
    }
    last = t
    return t
  })
  return { last: () => last as FakeTransport, built: () => built }
}

function liveSession() {
  setSession(
    sessionFromUser(
      {
        id: "00000000-0000-0000-0000-0000000000aa",
        email: "citizen@example.com",
        displayName: "রহিমা বেগম",
        role: "applicant",
        status: "active",
        createdAt: new Date().toISOString(),
      },
      false,
    ),
  )
}

function fakeFile(
  name: string,
  type: string,
  size = 1024,
): File {
  return new File([new Uint8Array(size)], name, { type })
}

test.afterEach(() => {
  setUploadTransportFactoryForTests(null)
  setCsrfToken(null)
  setSession(null)
})

/* -------------------------------------------------------------------------- */
/* Limits and validation                                                       */
/* -------------------------------------------------------------------------- */

test("Upload limits: client cap matches the backend default and stays under the proxy limit", () => {
  assert.strictEqual(UPLOAD_MAX_BYTES, 5 * 1024 * 1024)
  assert.strictEqual(UPLOAD_MAX_LABEL, "৫ এমবি")
  // The nginx front door allows 6 MiB; the client must not promise more than the
  // smaller backend default.
  assert.ok(UPLOAD_MAX_BYTES < 6 * 1024 * 1024)
  assert.strictEqual(ALLOWED_UPLOAD_ACCEPT, ".pdf,.jpg,.jpeg,.png")
})

test("Validation: accepted types and extensions pass", () => {
  assert.deepStrictEqual(validateUploadFile(fakeFile("a.pdf", "application/pdf")), {
    ok: true,
  })
  assert.deepStrictEqual(validateUploadFile(fakeFile("a.png", "image/png")), { ok: true })
  assert.deepStrictEqual(validateUploadFile(fakeFile("a.jpg", "image/jpeg")), {
    ok: true,
  })
  assert.deepStrictEqual(validateUploadFile(fakeFile("a.jpeg", "image/jpeg")), {
    ok: true,
  })
  // Some operating systems report an empty MIME type; the extension decides.
  assert.deepStrictEqual(validateUploadFile(fakeFile("scan.pdf", "")), { ok: true })
})

test("Validation: oversize, empty and unsupported files are rejected with actionable messages", () => {
  const tooBig = validateUploadFile(
    fakeFile("big.pdf", "application/pdf", UPLOAD_MAX_BYTES + 1),
  )
  assert.strictEqual(tooBig.ok, false)
  assert.strictEqual(tooBig.ok === false && tooBig.reason, "size")
  assert.ok(tooBig.ok === false && tooBig.message.includes(UPLOAD_MAX_LABEL))

  const empty = validateUploadFile(fakeFile("empty.pdf", "application/pdf", 0))
  assert.strictEqual(empty.ok, false)
  assert.strictEqual(empty.ok === false && empty.reason, "empty")

  const wrongType = validateUploadFile(fakeFile("notes.txt", "text/plain"))
  assert.strictEqual(wrongType.ok, false)
  assert.strictEqual(wrongType.ok === false && wrongType.reason, "type")
})

/* -------------------------------------------------------------------------- */
/* The request contract                                                        */
/* -------------------------------------------------------------------------- */

test("Upload contract: posts one file part to the documented query with credentials and CSRF", async () => {
  liveSession()
  setCsrfToken("csrf-from-login")
  const stub = stubUpload({
    status: 201,
    body: JSON.stringify({
      id: "00000000-0000-0000-0000-0000000000bb",
      title: "দলিল",
      status: "submitted",
    }),
  })

  const result = await uploadDocument({
    file: fakeFile("deed.pdf", "application/pdf"),
    title: "  দলিলের কপি  ",
  })

  const t = stub.last()
  assert.strictEqual(t.method, "POST")
  assert.ok(t.url.startsWith("/api/v1/documents/upload?"))
  const query = new URLSearchParams(t.url.split("?")[1])
  assert.strictEqual(query.get("title"), "দলিলের কপি")
  assert.strictEqual(query.get("kind"), UPLOAD_DOCUMENT_KIND)
  assert.strictEqual(t.withCredentials, true, "session cookie must be sent")
  assert.strictEqual(t.headers["x-csrf-token"], "csrf-from-login")
  assert.strictEqual(t.headers["accept"], "application/json")
  assert.ok(t.sentBody instanceof FormData)
  assert.ok((t.sentBody as FormData).get("file") instanceof File)
  assert.strictEqual((result as { title: string }).title, "দলিল")
})

test("Upload progress: the callback sees sent bytes and a percentage can be derived", async () => {
  liveSession()
  const stub = stubUpload({
    status: 201,
    body: "{}",
    progress: { loaded: 3, total: 10 },
  })

  const seen: number[] = []
  await uploadDocument(
    { file: fakeFile("a.pdf", "application/pdf"), title: "t" },
    { onProgress: (p) => seen.push(Math.round(((p.loaded ?? 0) / (p.total || 1)) * 100)) },
  )

  assert.deepStrictEqual(seen, [30])
  assert.ok(stub.last())
})

/* -------------------------------------------------------------------------- */
/* Failure mapping                                                             */
/* -------------------------------------------------------------------------- */

test("Upload failure: a 413 surfaces the size limit and never a fake success", async () => {
  liveSession()
  stubUpload({
    status: 413,
    body: JSON.stringify({
      error: { code: "payload_too_large", message: "Payload too large." },
    }),
  })

  await assert.rejects(
    () =>
      uploadDocument({
        file: fakeFile("big.pdf", "application/pdf"),
        title: "big",
      }),
    (err: unknown) => {
      assert.ok(err instanceof ApiError)
      assert.strictEqual(err.status, 413)
      assert.strictEqual(err.code, "payload_too_large")
      assert.ok(describeUploadError(err).includes(UPLOAD_MAX_LABEL))
      return true
    },
  )
})

test("Upload failure: a 415 explains the accepted types", async () => {
  liveSession()
  stubUpload({
    status: 415,
    body: JSON.stringify({
      error: { code: "unsupported_media_type", message: "Unsupported." },
    }),
  })

  await assert.rejects(
    () => uploadDocument({ file: fakeFile("x.pdf", "application/pdf"), title: "x" }),
    (err: unknown) => {
      assert.ok(err instanceof ApiError)
      assert.strictEqual(err.status, 415)
      assert.match(describeUploadError(err), /পিডিএফ|জেপিজি|পিএনজি/)
      return true
    },
  )
})

test("Upload failure: an expired session is reported as unauthenticated", async () => {
  liveSession()
  stubUpload({
    status: 401,
    body: JSON.stringify({
      error: { code: "unauthenticated", message: "Authentication required." },
    }),
  })

  await assert.rejects(
    () => uploadDocument({ file: fakeFile("x.pdf", "application/pdf"), title: "x" }),
    (err: unknown) => {
      assert.ok(err instanceof ApiError)
      assert.strictEqual(err.status, 401)
      assert.match(describeUploadError(err), /সেশন/)
      return true
    },
  )
})

test("Upload failure: a rejected CSRF token is explained, not swallowed", async () => {
  liveSession()
  stubUpload({
    status: 403,
    body: JSON.stringify({
      error: { code: "forbidden", message: "CSRF token missing or invalid." },
    }),
  })

  await assert.rejects(
    () => uploadDocument({ file: fakeFile("x.pdf", "application/pdf"), title: "x" }),
    (err: unknown) => {
      assert.ok(err instanceof ApiError)
      assert.strictEqual(err.status, 403)
      assert.match(describeUploadError(err), /CSRF/)
      return true
    },
  )
})

/* -------------------------------------------------------------------------- */
/* Demo mode must never fake a stored upload                                   */
/* -------------------------------------------------------------------------- */

test("Demo mode: upload is refused and the transport is never used", async () => {
  setSession({
    user: {
      id: "demo-citizen",
      email: "demo@example.com",
      displayName: "ডেমো",
      role: "applicant",
      status: "active",
      createdAt: new Date().toISOString(),
    },
    role: "citizen",
    displayName: "ডেমো",
    email: "demo@example.com",
    id: "demo-citizen",
    accountId: "demo@example.com",
    isDemo: true,
  })
  const stub = stubUpload({ status: 201, body: "{}" })

  await assert.rejects(
    () => uploadDocument({ file: fakeFile("a.pdf", "application/pdf"), title: "a" }),
    (err: unknown) => {
      assert.ok(err instanceof ApiError)
      assert.strictEqual(err.code, "demo_not_supported")
      return true
    },
  )
  // The transport factory must not have been built: no request was attempted.
  assert.strictEqual(stub.built(), 0)
})

/* -------------------------------------------------------------------------- */
/* Extraction review must not present a prototype decision as a live one       */
/* -------------------------------------------------------------------------- */

test("Extraction review: live mode refuses rather than posting a fixture id", async () => {
  liveSession()
  await assert.rejects(
    () =>
      recordReviewOutcome({
        fieldId: "area",
        outcome: "verified",
        proposedValue: "33",
        note: "",
      }),
    (err: unknown) => {
      assert.ok(err instanceof ApiError)
      assert.strictEqual(err.status, 501)
      assert.strictEqual(err.code, "extraction_review_not_implemented")
      return true
    },
  )
})
