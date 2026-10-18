import { ApiError, apiUpload, type UploadProgress } from "./client"
import { isCurrentSessionDemo } from "./session"
import type { BackendDocument, SourceDocumentKind } from "./types"

/**
 * Source-document upload against the BhoomiTrace backend.
 *
 * ## The contract this targets (verified against the running API)
 *
 * `POST /api/v1/documents/upload?title=<1..300>&kind=<kind>&reference=<optional>`
 * with a `multipart/form-data` body carrying exactly one file part. The declared
 * content type is ignored by the server; the leading bytes must be a PDF, PNG, or
 * JPEG signature. The request is authorised by the session cookie **and** the
 * `x-csrf-token` header, both attached by the client layer.
 *
 * ## Limits, kept in step with the stack
 *
 * The backend caps the file at `UPLOAD_MAX_BYTES` (default 5 MiB) and the nginx
 * front door allows 6 MiB. The client mirrors the smaller of the two so it never
 * advertises a size the stack would reject, and it treats the server as
 * authoritative for the accepted type.
 */

/** Matches the backend `UPLOAD_MAX_BYTES` default and stays under the 6 MiB proxy limit. */
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024

/** Human label for the size cap, used in copy and messages. */
export const UPLOAD_MAX_LABEL = "৫ এমবি"

/** MIME types the backend detects by signature. */
export const ALLOWED_UPLOAD_MIME_TYPES: readonly string[] = [
  "application/pdf",
  "image/jpeg",
  "image/png",
]

/** Extensions accepted by the file picker and used as a fallback when MIME is unknown. */
export const ALLOWED_UPLOAD_EXTENSIONS: readonly string[] = [
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
]

/** `accept` attribute for the file input. */
export const ALLOWED_UPLOAD_ACCEPT = ALLOWED_UPLOAD_EXTENSIONS.join(",")

/**
 * Document kind sent for a citizen-uploaded scan.
 *
 * The platform records the file as `user_created`; `kind` describes the nature of
 * the source. A photo or scan of a paper record is a reference to an external
 * record, which is what `external_reference` means.
 */
export const UPLOAD_DOCUMENT_KIND: SourceDocumentKind = "external_reference"

export type UploadValidationReason = "type" | "empty" | "size"

export type UploadValidation =
  | { ok: true }
  | { ok: false; reason: UploadValidationReason; message: string }

/**
 * Client-side pre-checks, run before the request so a rejected file never leaves
 * the machine. The server repeats every check; this is courtesy, not enforcement.
 */
export function validateUploadFile(file: File): UploadValidation {
  const name = file.name.toLowerCase()
  const extensionOk = ALLOWED_UPLOAD_EXTENSIONS.some((ext) => name.endsWith(ext))
  const mimeOk =
    file.type !== "" && ALLOWED_UPLOAD_MIME_TYPES.includes(file.type)

  if (!extensionOk && !mimeOk) {
    return {
      ok: false,
      reason: "type",
      message: "শুধু পিডিএফ, জেপিজি বা পিএনজি ফাইল নেওয়া হয়।",
    }
  }
  if (file.size === 0) {
    return { ok: false, reason: "empty", message: "ফাইলটি খালি।" }
  }
  if (file.size > UPLOAD_MAX_BYTES) {
    return {
      ok: false,
      reason: "size",
      message: `ফাইলটি ${UPLOAD_MAX_LABEL}-এর বেশি বড়। ছোট করে আবার চেষ্টা করুন।`,
    }
  }
  return { ok: true }
}

export interface UploadDocumentInput {
  file: File
  title: string
  kind?: SourceDocumentKind
  reference?: string
}

export interface UploadDocumentOptions {
  signal?: AbortSignal
  onProgress?: (progress: UploadProgress) => void
}

/**
 * Uploads one document for the signed-in account.
 *
 * Rejects in demo mode rather than faking a stored file: a demo session has no
 * backend to hold it, and pretending otherwise would present a mock upload as a
 * real one.
 */
export async function uploadDocument(
  input: UploadDocumentInput,
  options: UploadDocumentOptions = {},
): Promise<BackendDocument> {
  if (isCurrentSessionDemo()) {
    throw new ApiError(
      "ডেমো মোডে ফাইল আপলোড করা যায় না। আপলোড করতে সাইন ইন করুন।",
      400,
      "demo_not_supported",
    )
  }

  const params = new URLSearchParams()
  params.set("title", input.title.trim())
  params.set("kind", input.kind ?? UPLOAD_DOCUMENT_KIND)
  if (input.reference?.trim()) params.set("reference", input.reference.trim())

  const form = new FormData()
  form.append("file", input.file, input.file.name || "upload")

  return apiUpload<BackendDocument>(
    `/api/v1/documents/upload?${params.toString()}`,
    form,
    options,
  )
}

/** Turns any upload failure into a message a citizen can act on. */
export function describeUploadError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 413 || error.code === "payload_too_large") {
      return `ফাইলটি সার্ভারে গ্রহণযোগ্য ${UPLOAD_MAX_LABEL}-এর চেয়ে বড়।`
    }
    if (error.status === 415 || error.code === "unsupported_media_type") {
      return "ফাইলের ধরন শনাক্ত করা যায়নি। পিডিএফ, জেপিজি বা পিএনজি দিন।"
    }
    if (error.status === 401) {
      return "আপনার সেশন শেষ হয়ে গেছে। আবার সাইন ইন করে চেষ্টা করুন।"
    }
    if (error.status === 403) {
      return "নিরাপত্তা যাচাই (CSRF) ব্যর্থ হয়েছে। পাতা রিফ্রেশ করে আবার চেষ্টা করুন।"
    }
    if (error.status === 400 && error.code === "demo_not_supported") {
      return error.message
    }
    if (error.status === 0) {
      return "সার্ভারে পৌঁছানো যায়নি। সংযোগ পরীক্ষা করে আবার চেষ্টা করুন।"
    }
    return error.message || "আপলোড ব্যর্থ হয়েছে। আবার চেষ্টা করুন।"
  }
  return "আপলোড ব্যর্থ হয়েছে। আবার চেষ্টা করুন।"
}
