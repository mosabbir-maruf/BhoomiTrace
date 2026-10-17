import type { Database } from '../db/client.js'
import type { ExtractionProvider } from '../extraction/provider.js'
import {
  claimNextJob,
  completeJob,
  failJobAttempt,
  markJobReviewRequired,
  recoverExpiredLeases,
  type ClaimedJob,
} from '../services/jobs.js'
import {
  processClaimedJob,
  type JobProcessorContext,
} from './processor.js'

/**
 * The extraction worker loop.
 *
 * The worker is a separate process from the API server, because extraction is
 * slow and must not occupy a request handler. It is written to be safe to run
 * more than once: claiming uses `FOR UPDATE SKIP LOCKED`, so several workers
 * share the queue without coordination.
 *
 * Shutdown is graceful. On `SIGINT`/`SIGTERM` the loop stops taking new work,
 * finishes the job it is already running, and then exits. Abandoning a job
 * mid-flight would be recoverable anyway — the lease would expire — but waiting
 * avoids making a colleague's work wait for a lease to time out.
 */

export interface WorkerLogger {
  info: (details: Record<string, unknown>, message: string) => void
  warn: (details: Record<string, unknown>, message: string) => void
  error: (details: Record<string, unknown>, message: string) => void
}

export interface ExtractionWorkerOptions {
  database: Database
  provider: ExtractionProvider
  rulesVersion: string
  /** Identifies this worker in job leases and audit rows. */
  workerId: string
  leaseSeconds: number
  maxAttempts: number
  retryBackoffSeconds: number
  pollIntervalMs: number
  log: WorkerLogger
}

export class ExtractionWorker {
  private stopping = false
  private inFlight = false
  private wakeUp: (() => void) | undefined
  private lastRecoveryAt = 0

  constructor(private readonly options: ExtractionWorkerOptions) {}

  /** True while a job is being processed. Used by tests. */
  get busy(): boolean {
    return this.inFlight
  }

  /** Requests a graceful stop and releases any pending sleep. */
  requestStop(): void {
    this.stopping = true
    this.wakeUp?.()
  }

  /** Sleeps, but returns immediately when a stop has been requested. */
  private async pause(ms: number): Promise<void> {
    if (this.stopping) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUp = undefined
        resolve()
      }, ms)

      this.wakeUp = () => {
        clearTimeout(timer)
        this.wakeUp = undefined
        resolve()
      }
    })
  }

  /** The recovery interval: half the lease, capped at thirty seconds. */
  private get recoveryIntervalMs(): number {
    return Math.min((this.options.leaseSeconds * 1_000) / 2, 30_000)
  }

  /**
   * Claims and runs jobs until `requestStop` is called.
   *
   * @returns the number of jobs processed, for tests.
   */
  async run(maxJobs = Number.POSITIVE_INFINITY): Promise<number> {
    let processed = 0

    while (!this.stopping && processed < maxJobs) {
      try {
        await this.maybeRecoverExpiredLeases()

        const job = await claimNextJob(this.options.database, {
          workerId: this.options.workerId,
          leaseSeconds: this.options.leaseSeconds,
        })

        if (job === null) {
          await this.pause(this.options.pollIntervalMs)
          continue
        }

        await this.runJob(job)
        processed += 1
      } catch (error) {
        // A failure to claim is a database problem, not a job failure: log it
        // and back off rather than spinning.
        this.options.log.error(
          { err: error, workerId: this.options.workerId },
          'worker loop iteration failed',
        )
        await this.pause(Math.max(this.options.pollIntervalMs, 1_000))
      }
    }

    return processed
  }

  private async maybeRecoverExpiredLeases(): Promise<void> {
    const now = Date.now()
    if (now - this.lastRecoveryAt < this.recoveryIntervalMs) return
    this.lastRecoveryAt = now

    const recovered = await recoverExpiredLeases(this.options.database)
    if (recovered.length > 0) {
      this.options.log.warn(
        { recovered, workerId: this.options.workerId },
        'recovered jobs whose lease had expired',
      )
    }
  }

  private async runJob(job: ClaimedJob): Promise<void> {
    this.inFlight = true
    const startedAt = Date.now()

    const context: JobProcessorContext = {
      database: this.options.database,
      provider: this.options.provider,
      rulesVersion: this.options.rulesVersion,
      log: this.options.log,
    }

    this.options.log.info(
      {
        jobId: job.id,
        kind: job.kind,
        attempt: job.attemptCount,
        workerId: this.options.workerId,
      },
      'job claimed',
    )

    try {
      const outcome = await processClaimedJob(context, job)

      if (outcome.status === 'review_required') {
        await markJobReviewRequired(
          this.options.database,
          job.id,
          this.options.workerId,
          outcome.result,
        )
      } else {
        await completeJob(
          this.options.database,
          job.id,
          this.options.workerId,
          outcome.result,
        )
      }

      this.options.log.info(
        {
          jobId: job.id,
          status: outcome.status,
          durationMs: Date.now() - startedAt,
          workerId: this.options.workerId,
        },
        'job finished',
      )
    } catch (error) {
      const failure = await failJobAttempt(this.options.database, {
        jobId: job.id,
        workerId: this.options.workerId,
        error,
        backoffSeconds: this.options.retryBackoffSeconds,
      })

      this.options.log.warn(
        {
          jobId: job.id,
          status: failure.status,
          attempt: failure.attemptCount,
          maxAttempts: failure.maxAttempts,
          durationMs: Date.now() - startedAt,
          workerId: this.options.workerId,
        },
        'job attempt failed',
      )
    } finally {
      this.inFlight = false
    }
  }
}
