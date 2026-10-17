import { useCallback, useEffect, useState } from "react"

export type AsyncState<T,> = { status: "loading" } | {
  status: "error"
  error: Error
} | { status: "success"; data: T }

/** Runs an abortable loader whenever `key` changes; `retry` runs it again. */
export function useAsync<T>(
  load: (signal: AbortSignal) => Promise<T>,
  key: string,
) {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: "loading" })
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: "success", data })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setState({
          status: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        })
      },
    )
    return () => controller.abort()
    // `load` is expected to be a stable module-level function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt])

  const retry = useCallback(() => setAttempt((count) => count + 1), [])
  return { state, retry }
}
