import { Component, type ErrorInfo, type ReactNode } from "react"
import { ErrorState } from "./ui/States"

interface State {
  hasError: boolean
}

/** Last-resort guard so a rendering bug shows a recoverable message instead of a blank page. */
export default class ErrorBoundary extends Component<{
  children: ReactNode
  resetKey?: string
}, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidUpdate(previous: { resetKey?: string }) {
    if (this.state.hasError && previous.resetKey !== this.props.resetKey)
      this.setState({ hasError: false })
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Replace with an error-tracking service once one is chosen.
    console.error(error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="mx-auto max-w-[76rem] px-4 py-10 sm:px-6 lg:px-10">
          <ErrorState
            title="পাতাটি দেখানো যায়নি"
            onRetry={() => this.setState({ hasError: false })}
          >
            একটি অপ্রত্যাশিত ত্রুটি হয়েছে। আবার চেষ্টা করুন, অথবা অন্য পাতায় যান।
          </ErrorState>
        </div>
      )
    }
    return this.props.children
  }
}
