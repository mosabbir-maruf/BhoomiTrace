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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url =
    path.startsWith("http://") || path.startsWith("https://")
      ? path
      : `${API_BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`

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
    let errorData: {
      error?: {
        code?: string
        message?: string
        requestId?: string
        details?: unknown
      }
    } | null = null
    try {
      errorData = await response.json()
    } catch {
      // response body was not JSON
    }

    const message =
      errorData?.error?.message ||
      response.statusText ||
      `অনুরোধ ব্যর্থ হয়েছে (স্ট্যাটাস: ${response.status})`
    const code = errorData?.error?.code || `http_${response.status}`
    const requestId =
      errorData?.error?.requestId ||
      response.headers.get("x-request-id") ||
      undefined
    const details = errorData?.error?.details

    throw new ApiError(message, response.status, code, requestId, details)
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
