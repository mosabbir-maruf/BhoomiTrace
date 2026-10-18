/**
 * BhoomiTrace — API HTTP Client
 * Connects to the BhoomiTrace Fastify backend with CSRF synchronizer token handling,
 * session cookies, correlation ID propagation, and standardized error parsing.
 */

const envUrl = ((typeof import.meta !== "undefined" &&
  (import.meta.env?.VITE_API_URL ?? import.meta.env?.VITE_API_BASE_URL)) ??
  "") as string

// Relative API base by default: requests (/api/v1/...) are proxied by Vite
// in development to http://localhost:3000. Set VITE_API_URL for an absolute origin.
export const API_BASE_URL = envUrl.replace(/\/$/, "")

export const isApiConfigured = true

let inMemoryCsrfToken: string | null = null

/** Sets or clears the in-memory CSRF token issued at login or register. */
export function setCsrfToken(token: string | null): void {
  inMemoryCsrfToken = token
}

/**
 * Retrieves the current CSRF token from memory or the readable `bt_csrf` cookie.
 * In Fastify, `bt_csrf` is set on login/register and is readable by client scripts.
 */
export function getCsrfToken(): string | null {
  if (inMemoryCsrfToken) return inMemoryCsrfToken
  if (typeof document !== "undefined") {
    const match = document.cookie
      .split("; ")
      .find((row) => row.startsWith("bt_csrf="))
    if (match) {
      return decodeURIComponent(match.split("=")[1] ?? "")
    }
  }
  return null
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId?: string
  readonly details?: unknown

  constructor(
    message: string,
    status: number,
    code = "api_error",
    requestId?: string,
    details?: unknown,
  ) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.requestId = requestId
    this.details = details
  }
}

/** Resolves a caller-supplied path against the configured API base. */
function buildUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path
  return `${API_BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`
}

/**
 * Builds an `ApiError` from the backend's standard error envelope.
 *
 * Shared by the fetch-based `request` and the XHR-based `apiUpload`, so both
 * transports surface the same stable `code`, human message, and request id.
 */
function apiErrorFromPayload(
  status: number,
  statusText: string,
  payload: unknown,
  headerRequestId: string | null,
): ApiError {
  const envelope =
    payload !== null && typeof payload === "object"
      ? (payload as {
          error?: {
            code?: string
            message?: string
            requestId?: string
            details?: unknown
          }
        })
      : null
  const message =
    envelope?.error?.message ||
    statusText ||
    `অনুরোধ ব্যর্থ হয়েছে (স্ট্যাটাস: ${status})`
  const code = envelope?.error?.code || `http_${status}`
  const requestId = envelope?.error?.requestId || headerRequestId || undefined
  const details = envelope?.error?.details
  return new ApiError(message, status, code, requestId, details)
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = buildUrl(path)

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(init.headers as Record<string, string> || {}),
  }

  const method = (init.method || "GET").toUpperCase()
  const isStateChanging = ["POST", "PUT", "PATCH", "DELETE"].includes(method)

  if (isStateChanging) {
    const csrfToken = getCsrfToken()
    if (csrfToken && !headers["x-csrf-token"]) {
      headers["x-csrf-token"] = csrfToken
    }
  }

  // Do not override Content-Type if uploading FormData
  if (
    !(init.body instanceof FormData) &&
    !headers["Content-Type"] &&
    init.body !== undefined
  ) {
    headers["Content-Type"] = "application/json"
  }

  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      credentials: "include",
      headers,
    })
  } catch (err) {
    throw new ApiError(
      err instanceof Error
        ? err.message
        : "নেটওয়ার্ক সংযোগ ব্যর্থ হয়েছে। সার্ভার চালু আছে কিনা নিশ্চিত করুন।",
      0,
      "network_error",
    )
  }

  if (!response.ok) {
    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      // response body was not JSON
    }

    throw apiErrorFromPayload(
      response.status,
      response.statusText,
      payload,
      response.headers.get("x-request-id"),
    )
  }

  if (response.status === 204) {
    return null as T
  }

  const contentType = response.headers.get("content-type")
  if (contentType && contentType.includes("application/json")) {
    return (await response.json()) as T
  }

  return (await response.text()) as unknown as T
}

export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: "GET", signal })
}

export function apiPost<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body:
      body instanceof FormData
        ? body
        : body !== undefined
          ? JSON.stringify(body)
          : undefined,
    signal,
  })
}

export function apiPatch<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return request<T>(path, {
    method: "PATCH",
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })
}

export function apiPut<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return request<T>(path, {
    method: "PUT",
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })
}

export function apiDelete<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: "DELETE", signal })
}

export async function apiDownload(
  path: string,
  signal?: AbortSignal,
): Promise<{ blob: Blob; filename?: string }> {
  const url =
    path.startsWith("http://") || path.startsWith("https://")
      ? path
      : `${API_BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`

  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    signal,
  })

  if (!response.ok) {
    throw new ApiError(
      `ডাউনলোড ব্যর্থ হয়েছে (স্ট্যাটাস: ${response.status})`,
      response.status,
    )
  }

  const disposition = response.headers.get("content-disposition")
  let filename: string | undefined
  if (disposition && disposition.includes("filename=")) {
    const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)
    if (match && match[1]) {
      filename = match[1].replace(/['"]/g, "")
    }
  }

  const blob = await response.blob()
  return { blob, filename }
}

/* -------------------------------------------------------------------------- */
/* Uploads                                                                     */
/* -------------------------------------------------------------------------- */

export interface UploadProgress {
  /** Bytes sent to the server so far. */
  loaded: number
  /** Total bytes to send, or `null` when the browser cannot compute it. */
  total: number | null
}

export interface ApiUploadOptions {
  signal?: AbortSignal
  /** Called as the request body is transmitted. */
  onProgress?: (progress: UploadProgress) => void
}

/** Minimal shape of the XHR we depend on, so the transport stays testable. */
interface UploadTransport {
  open(method: string, url: string): void
  setRequestHeader(name: string, value: string): void
  send(body: FormData): void
  abort(): void
  withCredentials: boolean
  status: number
  statusText: string
  responseText: string
  getResponseHeader(name: string): string | null
  upload: { onprogress: ((event: ProgressEventLike) => void) | null }
  onload: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
  ontimeout: (() => void) | null
}

interface ProgressEventLike {
  loaded: number
  total: number
  lengthComputable: boolean
}

type TransportFactory = () => UploadTransport

let uploadTransportFactory: TransportFactory = () =>
  new XMLHttpRequest() as unknown as UploadTransport

/** Overrides the upload transport. Used only by tests. */
export function setUploadTransportFactoryForTests(
  factory: TransportFactory | null,
): void {
  uploadTransportFactory =
    factory ?? (() => new XMLHttpRequest() as unknown as UploadTransport)
}

/**
 * Uploads a multipart body with the same authentication and error contract as
 * `request`.
 *
 * XMLHttpRequest is used rather than `fetch` because it reports upload progress;
 * the browser `fetch` API cannot. Cookies are sent (`withCredentials`) and the
 * CSRF token is echoed in the documented header, so the request is authorised
 * exactly like every other state-changing call. Nothing is mocked: a live call
 * either reaches the backend or throws.
 */
export function apiUpload<T>(
  path: string,
  body: FormData,
  options: ApiUploadOptions = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const transport = uploadTransportFactory()
    transport.open("POST", buildUrl(path))
    transport.withCredentials = true
    transport.setRequestHeader("Accept", "application/json")

    const csrfToken = getCsrfToken()
    if (csrfToken) transport.setRequestHeader("x-csrf-token", csrfToken)

    if (options.onProgress) {
      const report = options.onProgress
      transport.upload.onprogress = (event) => {
        report({
          loaded: event.loaded,
          total: event.lengthComputable ? event.total : null,
        })
      }
    }

    const onAbort = () => transport.abort()
    if (options.signal) {
      if (options.signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"))
        return
      }
      options.signal.addEventListener("abort", onAbort)
    }
    const cleanup = () => options.signal?.removeEventListener("abort", onAbort)

    transport.onload = () => {
      cleanup()
      if (transport.status >= 200 && transport.status < 300) {
        const text = transport.responseText
        if (!text) {
          resolve(null as T)
          return
        }
        try {
          resolve(JSON.parse(text) as T)
        } catch {
          resolve(text as unknown as T)
        }
        return
      }
      let payload: unknown = null
      if (transport.responseText) {
        try {
          payload = JSON.parse(transport.responseText)
        } catch {
          payload = null
        }
      }
      reject(
        apiErrorFromPayload(
          transport.status,
          transport.statusText,
          payload,
          transport.getResponseHeader("x-request-id"),
        ),
      )
    }

    const fail = () => {
      cleanup()
      reject(
        new ApiError(
          "নেটওয়ার্ক সংযোগ ব্যর্থ হয়েছে। সার্ভার চালু আছে কিনা নিশ্চিত করুন।",
          0,
          "network_error",
        ),
      )
    }
    transport.onerror = fail
    transport.ontimeout = fail
    transport.onabort = () => {
      cleanup()
      reject(new DOMException("Aborted", "AbortError"))
    }

    transport.send(body)
  })
}

