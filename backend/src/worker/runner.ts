import type { Database } from '../db/client.js'
import type { ExtractionProvider } from '../extraction/provider.js'
import { JobLeaseLostError } from '../lib/errors.js'
import { safeErrorSummary } from '../lib/redact.js'
import {
  claimNextJob,
  failJobAttempt,
  recoverExpiredLeases,
  renewJobLease,
  type ClaimedJob,
  type JobFence,
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
 * ## A lease that is renewed, not just held
 *
 * A fixed lease is a guess about how long work takes, and a wrong guess is
 * expensive: too short and a second worker starts the same job while the first
 * is still reading; too long and a crashed worker's job is stalled. So the lease
 * is renewed while the job runs, at a fraction of its length, and *every write
 * the job makes is fenced on it*. If a renewal reports that the job is no longer
 * held, the worker stops: it logs, abandons the result, and lets recovery handle
 * the job. It never writes a result for a lease it does not hold.
 *
 * ## Where finalization happens
 *
 * The runner does not mark a job complete. The processor's `finalizeClaimedJob`
 * commits the domain effects, the terminal status, the result, the lease
 * release, and the audit row in one transaction; by the time it returns, the job
 * is already settled. So on success there is nothing left for the runner to do
 * but log. Only a *failure* — where the attempt ended without writing effects —
 * needs a further database action, and `failJobAttempt` performs it atomically
 * under the same lease guard.
 *
 * Shutdown is graceful. On `SIGINT`/`SIGTERM` the loop stops taking new work,
 * finishes the job it is already running, and then exits.
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
  /** Private storage directory, so a reader can be given the real document. */
  uploadDir: string
  /** Largest document that may be handed to a reader. */
  maxContentBytes: number
  log: WorkerLogger
}

export class ExtractionWorker {
  private stopping = false
  private inFlight = false
  private wakeUp: (() => void) | undefined
  private lastRecoveryAt = 0
  /** Set when this worker is no longer entitled to write the job's result. */
  private leaseLost = false

  constructor(private readonly options: ExtractionWorkerOptions) {}

  /** True while a job is being processed. Used by tests. */
  get busy(): boolean {
    return this.inFlight
  }

  /** True when the job in flight lost its lease. Used by tests. */
  get lostLease(): boolean {
    return this.leaseLost
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
   * How often the lease is renewed: a quarter of its length, at least 250 ms.
   *
   * Renewing well inside the lease leaves room for one slow renewal, so a brief
   * database pause does not expire the lease out from under a healthy job.
   */
  private get heartbeatIntervalMs(): number {
    return Math.max(250, Math.floor((this.options.leaseSeconds * 1_000) / 4))
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
    this.leaseLost = false
    const startedAt = Date.now()
    const fence: JobFence = { jobId: job.id, workerId: this.options.workerId }

    const context: JobProcessorContext = {
      database: this.options.database,
      provider: this.options.provider,
      rulesVersion: this.options.rulesVersion,
      fence,
      uploadDir: this.options.uploadDir,
      maxContentBytes: this.options.maxContentBytes,
      log: this.options.log,
    }

    const heartbeat = this.startHeartbeat(fence)

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
      // The processor commits the effects, the terminal status, the result, the
      // lease release, and the audit row atomically, so a resolved promise means
      // the job is already settled and there is nothing left to write.
      const outcome = await processClaimedJob(context, job)

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
      if (error instanceof JobLeaseLostError || this.leaseLost) {
        // Recording a failure for a job this worker does not hold would be
        // another write on somebody else's lease. Recovery owns it now.
        this.options.log.warn(
          {
            jobId: job.id,
            workerId: this.options.workerId,
            reason: safeErrorSummary(error),
          },
          'job lease lost; the attempt was abandoned',
        )
        return
      }

      try {
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
      } catch (failureError) {
        // The lease was already gone when the failure was recorded, so nothing
        // was written. Recovery owns the job; treat the attempt as abandoned.
        if (failureError instanceof JobLeaseLostError) {
          this.options.log.warn(
            {
              jobId: job.id,
              workerId: this.options.workerId,
              reason: safeErrorSummary(failureError),
            },
            'job lease lost while recording the failure; recovery owns it',
          )
          return
        }
        throw failureError
      }
    } finally {
      await heartbeat.stop()
      this.inFlight = false
    }
  }

  /**
   * Renews the lease while a job runs.
   *
   * The renewals are serialised — a tick is skipped while the previous one is
   * still in flight — so a slow database cannot pile up overlapping updates.
   */
  private startHeartbeat(fence: JobFence): { stop: () => Promise<void> } {
    let stopped = false
    let renewal: Promise<void> | undefined

    const timer = setInterval(() => {
      if (stopped || this.leaseLost || renewal !== undefined) return
      renewal = this.renewLease(fence).finally(() => {
        renewal = undefined
      })
    }, this.heartbeatIntervalMs)

    // A heartbeat must not by itself keep the process alive.
    timer.unref()

    return {
      stop: async () => {
        stopped = true
        clearInterval(timer)
        if (renewal !== undefined) await renewal
      },
    }
  }

  private async renewLease(fence: JobFence): Promise<void> {
    try {
      const renewal = await renewJobLease(this.options.database, {
        jobId: fence.jobId,
        workerId: fence.workerId,
        leaseSeconds: this.options.leaseSeconds,
      })

      if (renewal === 'renewed') return

      if (renewal === 'settled') {
        // The job already reached a terminal state — this worker finished it, or
        // recovery moved it on. There is nothing to renew and nothing to warn
        // about: the finalization fence is the authority on whether a write is
        // still permitted.
        return
      }

      this.leaseLost = true
      this.options.log.error(
        { jobId: fence.jobId, workerId: fence.workerId },
        'job lease was lost; this worker will not record a result',
      )
    } catch (error) {
      // A renewal that cannot be confirmed is treated as a lost lease.
      // Continuing would risk two workers writing the same job's results, which
      // is worse than discarding one attempt: the job is recovered by lease
      // expiry and retried.
      this.leaseLost = true
      this.options.log.error(
        {
          jobId: fence.jobId,
          workerId: fence.workerId,
          reason: safeErrorSummary(error),
        },
        'job lease renewal failed; treating the lease as lost',
      )
    }
  }
}
