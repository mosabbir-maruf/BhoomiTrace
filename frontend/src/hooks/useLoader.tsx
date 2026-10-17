import type { ReactNode } from "react"
import { useAsync } from "./useAsync"
import { useDataSourceKey } from "@/lib/api/session"
import { NotFoundError } from "@/mocks/service"
import {
  EmptyState,
  ErrorState,
  LoadingRegion,
  Skeleton,
} from "@/components/ui/States"
import { LinkButton } from "@/components/ui/Button"

interface LoadProps<T> {
  load: (signal: AbortSignal) => Promise<T>
  /** Changes to this key reload the data (for example a record ID). */
  loadKey: string
  notFound?: { title: string; backHref: string; backLabel: string }
  /** Wrap loading and error states in the page frame (for screens whose heading comes from the data). */
  framed?: boolean
  children: (data: T) => ReactNode
}

/** Shared loading, error and not-found handling for every data screen. */
export default function Load<T>({
  load,
  loadKey,
  notFound,
  framed = false,
  children,
}: LoadProps<T>) {
  const source = useDataSourceKey()
  const { state, retry } = useAsync(load, `${source}:${loadKey}`)
  if (state.status === "success") return <>{children(state.data)}</>

  let content: ReactNode
  let heading = "তথ্য আনা যায়নি"
  if (state.status === "loading") {
    heading = "তথ্য আনা হচ্ছে"
    content = (
      <LoadingRegion label="তথ্য আনা হচ্ছে…">
        <div className="space-y-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      </LoadingRegion>
    )
  } else if (
    notFound &&
    (state.error instanceof NotFoundError ||
      (state.error as { status?: number }).status === 404)
  ) {
    heading = notFound.title
    content = (
      <EmptyState
        title={notFound.title}
        icon="search"
        action={
          <LinkButton href={notFound.backHref} variant="secondary">
            {notFound.backLabel}
          </LinkButton>
        }
      >
        লিংকটি পুরোনো হতে পারে, অথবা এই ডেমোর নমুনা তথ্যে এমন কিছু নেই।
      </EmptyState>
    )
  } else {
    content = (
      <ErrorState title="তথ্য আনা যায়নি" onRetry={retry}>
        সংযোগে সমস্যা হয়েছে। আপনার কোনো তথ্য হারায়নি; একটু পরে আবার চেষ্টা করুন।
      </ErrorState>
    )
  }
  // Framed screens take their heading from the data, so give these states their own.
  return framed ? (
    <div className="page-width py-8">
      <h1 className="sr-only">{heading}</h1>
      {content}
    </div>
  ) : (
    content
  )
}
