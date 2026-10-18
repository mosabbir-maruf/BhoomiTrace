<div align="center">

<img src="../frontend/public/favicon.svg" alt="BhoomiTrace" width="100" height="100" />

# BhoomiTrace

### AI-assisted land-record verification and parcel-lineage platform

BhoomiTrace links land-record evidence to traceable values, checks parcel lineage and area/share arithmetic, and surfaces explainable discrepancies for human review.

**Track:** LandTech 2026 &nbsp;·&nbsp; **Challenge:** AI-assisted land-record verification

### 🌐 [Live Demo — devtree.online](https://devtree.online/)

[![Live Demo](https://img.shields.io/badge/Live%20Demo-devtree.online-2ea44f?style=flat-square)](https://devtree.online/)
[![CI](https://github.com/mosabbir-maruf/BhoomiTrace/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mosabbir-maruf/BhoomiTrace/actions/workflows/ci.yml)
[![Backend Docker Image](https://img.shields.io/badge/GHCR-Backend%20image-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/mosabbir-maruf/packages/container/bhoomitrace-backend)
[![Frontend Docker Image](https://img.shields.io/badge/GHCR-Frontend%20image-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/mosabbir-maruf/packages/container/bhoomitrace-frontend)
[![License: MIT](https://img.shields.io/badge/License-MIT-3DA639?style=flat-square)](https://github.com/mosabbir-maruf/BhoomiTrace/blob/main/LICENSE)

[![Node.js 24](https://img.shields.io/badge/Node.js-24-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/docs/latest-v24.x/api/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/docs/)
[![Fastify 5](https://img.shields.io/badge/Fastify-5-000000?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev/docs/latest/)
[![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL-17-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/docs/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/learn)
[![Vite 8](https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vite.dev/guide/)
[![Tailwind CSS 4](https://img.shields.io/badge/Tailwind%20CSS-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/docs)
[![Vitest 5](https://img.shields.io/badge/Vitest-5-6DA544?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev/guide/)

</div>

> **Demo scope:** The demo uses synthetic records. BhoomiTrace supports verification and review; it does not determine legal ownership or issue official legal approval.

---

> **Guide scope:** Production deployment and operations runbook for the separate single-host Compose stack. This is not the local judge quickstart; begin with the [root README](../README.md) for local execution.

This directory is a **standalone** production deployment: a separate Compose
project, an HTTPS edge proxy, EBS-backed persistence, off-host backups with a
restore drill, monitoring configuration, and an immutable-image deploy/rollback
path.

It does not modify `docker-compose.yml` or any local development workflow. The
two stacks can run on the same host without sharing a project, a network, a
volume, or a port.

> **Read this first.** Everything below has been exercised on a local Docker
> host. The AWS-specific steps (SSM/Secrets Manager, S3, CloudWatch, a real
> Let's Encrypt certificate) have **not** been run against real AWS resources
> and are marked as such in [Verification status](#verification-status). Do not
> read this document as a claim that the AWS path is proven.

---

## 1. What this is, and what it is not

**What it provides**

* A reproducible, immutable-image deployment of the API, worker, SPA and edge
  proxy on one EC2 instance.
* No database or API port exposed to the public internet. Only the edge proxy
  publishes ports, and the API is reachable exclusively through it.
* Database and evidence on a dedicated EBS volume, bind-mounted at explicit
  host paths that the API and worker share.
* Verified backups: PostgreSQL in custom format with a table-of-contents check,
  evidence as a hash-compared tarball, uploaded to S3 with encryption and
  retention, plus a restore drill against disposable resources.
* A rollback path that restores **image references only**, with an explicit
  warning that it does not reverse a schema change.

**What it is not**

* **Not highly available.** One EC2 instance is a single point of failure. The
  instance, its availability zone, or the EBS volume failing means downtime
  until you restore. There is no failover, no replica, no load balancer.
* **EBS is not a backup.** Replicated storage protects against a disk failure,
  not against a bad migration, an accidental delete, or a compromised host.
  The S3 copies are the backup.
* **Not verified against real AWS.** See [Verification status](#verification-status).
* **Not a complete product.** The Phase 5 audit remains **NO-GO for real
  production**: there is no OCR, no account lockout, the extraction reviewer
  endpoints are absent, and no live Gemini/Groq call has ever been made. This
  baseline makes a *synthetic-data demo* survivable; it does not make the
  product complete.

---

## 2. Architecture

```
                    internet
                       │  80 (redirect + ACME) / 443 (TLS)
                       ▼
            ┌──────────────────────┐
            │  edge  (nginx)       │  only service with published ports
            │  TLS termination     │  overwrites X-Forwarded-For/-Proto
            └───┬──────────────┬───┘
                │ /            │ /api/
                ▼              ▼
     ┌───────────────┐  ┌──────────────┐
     │ frontend      │  │ api  :3000   │
     │ SPA  :8080    │  └──┬───────────┘
     └───────────────┘     │
                           ▼
     ┌───────────────┐  ┌──────────────┐      ┌──────────────────┐
     │ worker        │─▶│ postgres     │      │ migrate (one-shot)│
     └───────────────┘  └──────────────┘      └──────────────────┘
             │                 │                      │
             └────────┬────────┴──────────────────────┘
                      ▼
        EBS volume, bind-mounted at explicit host paths
        ${BHOOMITRACE_DATA_DIR}/postgres   → /var/lib/postgresql/data   (uid 70)
        ${BHOOMITRACE_DATA_DIR}/uploads    → /data/uploads   (uid 1000, api AND worker)
```

Compose project name: `bhoomitrace-prod` (independent of the dev stack).
Network: a single private bridge; nothing on it is published except the edge.

**Forced production environment.** Every backend service inherits
`NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY=true` and
`UPLOAD_DIR=/data/uploads` from one shared anchor. They cannot be overridden per
service, and `preflight.sh` asserts the rendered values.

**Trusted proxy handling.** The edge sets `X-Forwarded-For` to the real peer
address (it *overwrites* whatever the client sent) and `X-Forwarded-Proto:
https`. With `TRUST_PROXY=true`, the API therefore sees the true client address
and cannot be spoofed by a forged header.

**Synthetic seed data** is behind the `demo` Compose profile and is off by
default. It runs with `NODE_ENV=development` because the application refuses to
seed a production database, and that guard is deliberately not weakened.

---

## 3. Prerequisites

| Requirement | Notes |
| --- | --- |
| EC2 instance | Ubuntu 22.04+ / Amazon Linux 2023, ≥ 2 vCPU, ≥ 4 GB RAM. |
| Docker Engine + Compose plugin | `docker compose version` must work without `sudo`. |
| Docker Compose ≥ 2.x | Parses the `name:` key and `service_completed_successfully`. |
| Dedicated EBS volume | Not the root volume. Sized for database + evidence + local backup staging. |
| IAM **instance role** | SSM/Secrets Manager read, S3 write, CloudWatch write. No static keys. |
| `aws` CLI v2 | Present on the host for backups, secrets, and CloudWatch. |
| DNS A record | `DOMAIN` must resolve to the instance's public address. |
| Open ports 80 + 443 | 80 is needed for the TLS challenge and the redirect. |
| `certbot` | Only for the Let's Encrypt flow (`issue-certificate.sh`). |
| Repository checkout | The systemd units assume `/opt/bhoomitrace`. Adjust if you clone elsewhere. |

**Security group:** allow 443 from the internet, 80 from the internet (ACME +
redirect), 22 from your admin address only. Do **not** open 5432 or 3000.

---

## 4. Step 1 — the EBS data volume

The stack refuses to run with its data directory on the root filesystem: that is
how a full root volume takes the database down with it.

**4.1 Attach and identify the volume.** Attach the EBS volume in the console
(or on an instance with an attached secondary volume), then confirm which device
it appeared as. `nvme1n1` is a guess unless you verify it:

```bash
lsblk -o NAME,SIZE,TYPE,MOUNTPOINT,MODEL
# NVMe names are not stable across reboots. Match the serial to the volume ID:
for d in /dev/nvme*n1; do
  printf '%s ' "$d"
  sudo nvme id-ctrl -v "$d" | awk -F: '/^sn /{gsub(/ /,"",$2); print $2}'
done
# For a gp3 volume, `sn` is `vol<volume-id-without-dash>`.
```

**4.2 Format — only if the volume is new and empty.** `mkfs` destroys data.
Check `lsblk -f` first; never run this on a volume that already holds a
filesystem.

```bash
sudo lsblk -f /dev/nvme1n1          # confirm there is no existing filesystem
sudo mkfs.ext4 -L bhoomitrace-data /dev/nvme1n1
```

**4.3 Mount by UUID, so the volume survives reboots and device renaming.**

```bash
sudo mkdir -p /srv/bhoomitrace
UUID="$(sudo blkid -s UUID -o value /dev/nvme1n1)"
echo "UUID=$UUID /srv/bhoomitrace ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab
sudo mount -a
findmnt /srv/bhoomitrace            # must show the EBS device, not the root fs
```

`nofail` keeps the instance bootable if the volume is ever detached.

**4.4 Confirm you are on the volume, not the root filesystem.**

```bash
df -PT /srv/bhoomitrace
df -PT /
# The "Filesystem" column must differ between the two.
```

`prepare-host.sh` performs this same check and refuses to continue if the data
directory resolves to the root filesystem. It also prints the resolved device
and owner for every directory it touches, so you can see exactly what it did.

**4.5 Ownership.** Do not create the data directories by hand with your own
`umask`. `prepare-host.sh` creates them with the ownership the containers need:

| Directory | Mode | Owner | Why |
| --- | --- | --- | --- |
| `postgres/` | `0700` | `70:70` | `postgres:17-alpine` runs as uid 70 |
| `uploads/` | `0750` | `1000:1000` | the backend image's `node` user |
| `tls/` | `0700` | `0:0` | private key material, read by the edge container |
| `backups/` | `0700` | `0:0` | dumps of the entire database |
| `state/` | `0700` | `0:0` | recorded release references |
| `logs/` | `0750` | `0:0` | log files the CloudWatch agent reads |

---

## 5. Step 2 — IAM instance role

Attach a role to the instance. No credentials are ever written to disk, passed
as arguments, or committed. The instance metadata service supplies the role; the
`aws` CLI and the scripts use that default credential chain.

Replace `BUCKET` and `ACCOUNT` and tighten the S3 resource to your bucket/prefix:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadStackSecrets",
      "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:GetParameters"],
      "Resource": "arn:aws:ssm:REGION:ACCOUNT:parameter/bhoomitrace/prod/*"
    },
    {
      "Sid": "ReadSecretsManagerIfUsed",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:REGION:ACCOUNT:secret:bhoomitrace/prod/*"
    },
    {
      "Sid": "DecryptSecretsIfKmsEncrypted",
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "arn:aws:kms:REGION:ACCOUNT:key/KEY-ID"
    },
    {
      "Sid": "WriteBackups",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::BUCKET/bhoomitrace/*"
    },
    {
      "Sid": "VerifyBackups",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::BUCKET",
      "Condition": { "StringLike": { "s3:prefix": ["bhoomitrace/*"] } }
    },
    {
      "Sid": "ConfigureBucketProtections",
      "Effect": "Allow",
      "Action": [
        "s3:GetBucketEncryption", "s3:PutBucketEncryption",
        "s3:GetBucketLifecycleConfiguration", "s3:PutBucketLifecycleConfiguration",
        "s3:GetBucketPolicy", "s3:PutBucketPolicy"
      ],
      "Resource": "arn:aws:s3:::BUCKET"
    },
    {
      "Sid": "PublishOperationalMetrics",
      "Effect": "Allow",
      "Action": "cloudwatch:PutMetricData",
      "Resource": "*",
      "Condition": { "StringEquals": { "cloudwatch:namespace": "BhoomiTrace" } }
    }
  ]
}
```

Notes:

* `s3api head-object` (used to prove an upload landed) is authorised by
  `s3:GetObject` on the object resource.
* `ConfigureBucketProtections` is only needed if you run
  `configure-s3-lifecycle.sh` from the instance. If you configure the bucket
  once from an admin workstation, drop this statement.
* `PutMetricData` is only used when `BHOOMITRACE_CLOUDWATCH_NAMESPACE` is set.
  With it unset, the scripts log successes and failures locally and publish
  nothing.

---

## 6. Step 3 — secrets in SSM or Secrets Manager

Only one secret is required: the PostgreSQL password. Store it in SSM
Parameter Store (or in a Secrets Manager secret holding the same
`KEY=VALUE` lines):

```bash
# Generated on the workstation, never echoed, never committed:
aws ssm put-parameter \
  --name /bhoomitrace/prod/secrets \
  --type SecureString \
  --value "POSTGRES_PASSWORD=$(openssl rand -hex 32)" \
  --region ap-south-1
```

Fetch it on the host:

```bash
cd /opt/bhoomitrace
sudo -u ubuntu deploy/scripts/fetch-secrets.sh --region ap-south-1
sudo chmod 600 deploy/env/secrets.env
```

`fetch-secrets.sh` writes `deploy/env/secrets.env` with mode `0600` and refuses
to leave a partial or empty file behind if the fetch fails. If
`EXTRACTION_PROVIDER` is `gemini` or `groq`, add the corresponding key to the
same parameter as an extra `KEY=VALUE` line.

Never pass the password on a command line where it would land in shell history
or `ps` output. Nothing in this directory prints secret values.

---

## 7. Step 4 — configuration

```bash
cd /opt/bhoomitrace
cp deploy/env/stack.env.example deploy/env/stack.env
chmod 600 deploy/env/stack.env
$EDITOR deploy/env/stack.env
```

Every knob is documented inline in
[`env/stack.env.example`](env/stack.env.example). The values that matter most:

* `DOMAIN` — the exact hostname the certificate is issued for.
* `CORS_ALLOWED_ORIGINS` — **exactly** `https://<DOMAIN>`, with no trailing
  slash, no wildcard, and no path. On a non-default `EDGE_HTTPS_PORT` it must
  include the port (`https://<DOMAIN>:8443`), because that is the origin a
  browser actually sends. A mismatch makes every state-changing request fail
  with `403`.
* `BHOOMITRACE_DATA_DIR` — the EBS mount point from Step 1.
* `BACKEND_IMAGE` / `FRONTEND_IMAGE` — immutable `ghcr.io/...:sha-<40 hex>` or
  `@sha256:<digest>` references. `preflight.sh` refuses `latest` and any
  mutable tag.
* `BACKUP_S3_BUCKET` — required for unattended backups. With it empty, a backup
  without `--no-upload` fails rather than silently producing an on-host-only
  copy.

Validate before deploying:

```bash
deploy/scripts/preflight.sh
```

It checks, among other things: secrets file mode, no example password,
immutable image references, certificate presence/expiry/SAN/key match, data
directories present and not on the root filesystem, only the edge publishing
ports, the forced production environment, the shared upload directory, and the
seed service staying behind its profile. It accumulates every failure and exits
non-zero, so you fix them in one pass.

---

## 8. Step 5 — host preparation

```bash
sudo deploy/scripts/prepare-host.sh --check   # report only, changes nothing
sudo deploy/scripts/prepare-host.sh           # create/repair the layout
```

It resolves the filesystem backing the data directory, refuses to run on the
root filesystem, then creates each directory with the mode and ownership in the
table in Step 1. It never deletes or overwrites data: an existing directory is
left alone and reported. Run `--check` first on an existing host.

---

## 9. Step 6 — TLS certificate

`issue-certificate.sh` uses certbot's `--standalone` HTTP-01 challenge, which
requires port 80 to be reachable from the internet and `DOMAIN` to resolve here.

```bash
# Rehearse first: staging certificates are untrusted but do not consume the
# production rate limit.
sudo apt-get install -y certbot
DOMAIN=... deploy/scripts/issue-certificate.sh --staging --email ops@example.org

# Then the real one:
sudo deploy/scripts/issue-certificate.sh --email ops@example.org
```

It installs a flat pair at `${BHOOMITRACE_TLS_DIR}/fullchain.pem` and
`privkey.pem` (mode `0600`, root-owned) which the edge mounts read-only, and it
warns if the certificate does not list `DOMAIN` in its SAN.

Renewal is automated by the `bhoomitrace-cert-renew` timer (twice daily), whose
`certbot renew --deploy-hook` calls `tls-deploy-hook.sh` to copy the new pair
into place and reload the edge. `preflight.sh` and the health check both refuse
to accept an expired certificate.

> **Do not claim a secure public deployment without a certificate that verifies
> for your real hostname.** A self-signed certificate is fine for a local
> rehearsal and is explicitly banned from the production path by preflight.

---

## 10. Step 7 — first deploy

```bash
cd /opt/bhoomitrace
deploy/scripts/deploy.sh --note "first production deploy"
```

`deploy.sh` runs, in order:

1. `preflight.sh` — full configuration validation.
2. `record-release.sh --from-running` — record what is running *before* the
   change, so the previous state is not lost.
3. `backup-all.sh --label pre-deploy` — a database dump and an evidence archive
   exist before any schema change. (Skip only with `--skip-backup`, which warns
   loudly that there is no recovery point.)
4. `docker pull` both images — a failed pull aborts before anything is replaced.
5. Record the applied migration count.
6. `compose up -d --remove-orphans` — the one-shot `migrate` service runs first
   and must exit 0 before the API and worker start.
7. Wait for every container to report healthy (default 180 s, `--wait-seconds`).
8. Full `health-check.sh` — readiness, liveness, frontend reachability, the
   edge's TLS and `/api/` routing, the HTTP→HTTPS redirect, and disk space.
9. Record the new release and report `schema_changed=true|false`.

If the health gate fails, the output includes the container table and recent API
/ worker / migrate logs. With `--rollback-on-failure` it also attempts the
image-only rollback (and says clearly that the schema is not reverted).

Post-deploy verification:

```bash
deploy/scripts/health-check.sh
curl -sS https://$DOMAIN/health   | jq .
curl -sS https://$DOMAIN/health/live
```

`/health` is readiness (it fails when the database is unreachable);
`/health/live` is liveness and must not be used to decide about database health.

**Optional** — synthetic demo data (never against real records):

```bash
deploy/scripts/compose.sh --profile demo run --rm seed
```

Then create the first operator account out of band. There is no public endpoint
that can create a reviewer or administrator, by design:

```bash
deploy/scripts/compose.sh run --rm --no-deps --entrypoint node api \
  dist/cli/bootstrap-account.js --email you@example.org --role admin --name "Your Name"
```

The generated password is printed once. Store it in a password manager.

---

## 11. Step 8 — scheduling: backups, health, renewal

```bash
sudo deploy/scripts/install-systemd-units.sh --enable
```

This installs three timers (it requires the repository at `/opt/bhoomitrace`):

| Unit | Schedule | What it runs |
| --- | --- | --- |
| `bhoomitrace-backup` | daily 20:15 UTC | `backup-all.sh` (database + evidence + S3) |
| `bhoomitrace-health` | every 5 minutes | `health-check.sh --skip-public` |
| `bhoomitrace-cert-renew` | 00:30 and 12:30 UTC | `certbot renew` + `tls-deploy-hook.sh` |

Check on them:

```bash
systemctl list-timers 'bhoomitrace-*'
systemctl status bhoomitrace-backup.timer
journalctl -u bhoomitrace-backup.service -n 50
tail -n 20 /srv/bhoomitrace/logs/backup.log
```

Every script prints a single machine-readable result line, so a failed run is
unambiguous in the journal and in CloudWatch Logs:

```
BACKUP RESULT: SUCCESS kind=database file=... bytes=... toc=... s3=...
BACKUP RESULT: FAILURE kind=database reason=...
HEALTH RESULT: SUCCESS failures=0 skips=1
HEALTH RESULT: FAILURE failures=3 skips=1
```

### What a backup contains, and how it is verified

`backup-all.sh` takes one timestamp and produces a matching pair:

* `backups/database/<db>-<db>-<ts>.dump` — `pg_dump --format=custom -Z6`,
  streamed straight out of the container so nothing large is written to the root
  volume, with `--no-owner --no-privileges` so it restores to a different host.
* `backups/uploads/<db>-uploads-<ts>.tar.gz` — the evidence directory.
* For each: a `.sha256` sidecar and a `.meta` sidecar.

Before upload, each artifact is validated: the dump's table of contents is read
back with `pg_restore --list`, must contain the `drizzle` migration journal, and
must have a non-zero entry count; the archive's entry count must match the file
count it was built from. After upload, the object is read back with
`s3api head-object` and its size and encryption state must match what was
requested. A 200 from `aws s3 cp` alone is never treated as success.

Local retention (`BACKUP_LOCAL_RETENTION_DAYS`) prunes only files this project
created, only inside its own backup directory, and never the newest artifact.

### S3 lifecycle

```bash
deploy/scripts/configure-s3-lifecycle.sh --dry-run
deploy/scripts/configure-s3-lifecycle.sh
```

Creates one lifecycle rule (`bhoomitrace-backup-retention`) that aborts
incomplete multipart uploads, transitions objects through
STANDARD_IA → GLACIER_IR, and expires them after `BACKUP_RETENTION_DAYS`. With
`--apply-encryption` and `--apply-tls-only-policy` it also enforces default
bucket encryption and a deny-insecure-transport bucket policy.

---

## 12. Restore

### 12.1 The drill (do this on a schedule, not in an emergency)

```bash
deploy/scripts/restore-drill.sh
```

It is deliberately paranoid and uses **only disposable resources**:

1. Starts a throwaway `postgres:17-alpine` container on its own network.
2. Takes a fresh backup of the running stack (read-only against the source).
3. Restores the dump into a new scratch database in the throwaway container.
4. Compares source and restored databases **table by table** (row counts and
   the migration count) and fails on any difference.
5. Restores the evidence archive and compares per-file SHA-256 hashes.
6. Starts the API image against the restored database and checks readiness,
   liveness, and that unauthenticated access is still refused.
7. Tears everything down and prints a PASS/FAIL report.

`--keep` leaves the workspace behind for inspection. `--source-dump FILE`
rehearses restoring a dump that already exists.

### 12.2 Restoring for real

Scratch (the default) requires an explicit target and cannot touch the
production stack:

```bash
deploy/scripts/restore.sh --dump backups/database/db-db-<ts>.dump \
  --target-container <some-running-postgres> --target-db rehearsal
```

Production overwrite requires **three independent gates**, so it cannot happen
by a typo, a stray flag, or a copied command line:

```bash
deploy/scripts/restore.sh --dump <file> --mode production --force-production \
  --uploads-tar <file>
#   gate 1: --mode production --force-production
#   gate 2: RESTORE_PRODUCTION_CONFIRM=overwrite-production-data in the environment
#   gate 3: typing the database name at an interactive terminal
```

In production mode it stops the API and worker, drops and recreates the target
database, restores with `--exit-on-error --no-owner --no-privileges`, and moves
the existing evidence aside as `*.pre-restore-<timestamp>` rather than deleting
it. No volume is removed and no data directory is overwritten.

### 12.3 Migrations are forward-only

**An image rollback does not reverse a migration.** `drizzle` migration files
are applied in order and there are no down-migrations. If a release changed the
schema and then failed, rolling the images back leaves the new schema in place
against older code.

The decision procedure after a schema-changing release goes wrong:

1. `deploy/scripts/rollback.sh --list` — see what is recorded.
2. If the old code can run against the new schema, roll the images back.
3. If it cannot, **restore first**: restore the pre-deploy dump from Step 3 of
   the deploy (Section 12.2), then deploy the image pair that matches that
   backup. The dump and the images must be from the same release.
4. Do not delete the failed dump. It is the only forensic copy.

---

## 13. Deploy and rollback with immutable references

Images are never referenced by a mutable tag. `.github/workflows/publish-image.yml`
produces `sha-<40 hex>` tags; `preflight.sh` enforces immutability.

```bash
deploy/scripts/record-release.sh --from-running        # record what is live now
deploy/scripts/rollback.sh --list                      # list the recorded releases
```

State lives in `${BHOOMITRACE_STATE_DIR}`: `current.env`, `previous.env`, and
`deployed.env` (the release actually observed running, which catches a manual
`docker compose` edit made outside the scripts).

```bash
# Roll back to the previous release (the default target):
deploy/scripts/rollback.sh
# Roll back to a specific recorded release:
deploy/scripts/rollback.sh --to /srv/bhoomitrace/state/previous.env --yes
```

`rollback.sh` pulls the target images **before** changing anything, so a failed
pull leaves the running stack untouched. It then rewrites only `BACKEND_IMAGE`
and `FRONTEND_IMAGE` in `stack.env`, backs that file up first, and recreates
`api`, `worker`, `frontend` and `edge` with `--no-deps`. It never runs
migrations and always prints the "schema was not reverted" warning.

---

## 14. Monitoring and alerting

The repository ships configuration, not active alarms:

* `cloudwatch/amazon-cloudwatch-agent.json` — agent config that ships
  `/srv/bhoomitrace/logs/{backup,health,deploy,restore,cert-renew}.log` to
  `/bhoomitrace/prod/*` log groups, and collects CPU, memory and disk metrics
  under the `BhoomiTrace` namespace.
* `cloudwatch/alarms.md` — the exact `put-metric-alarm` commands for host
  status, disk pressure, service unavailability, and backup failure, plus how to
  configure notifications and how to prove an alert actually fires.

To publish application-level metrics, set
`BHOOMITRACE_CLOUDWATCH_NAMESPACE=BhoomiTrace` in the environment of the
scheduled units. `backup-*` scripts then publish `BackupSuccess`/`BackupFailure`
and `health-check.sh` publishes `HealthCheckFailure`. With the variable unset,
nothing is published — this is why an alarm based on those metrics will not
exist until you create it *and* set the variable.

**An alarm template in this repository is not a working alarm.** Until the
commands in `cloudwatch/alarms.md` have been run, the notification topic
subscribed, and a test notification received, there is no alerting. Follow the
"prove it fires" steps there before relying on it.

---

## 15. Verification status

Everything below was run on a local Docker host (Docker Compose v5.1.3, macOS).
The production stack was brought up as a **separate** project against scratch
directories, a local registry holding two immutable image releases, a
self-signed certificate for `localhost`, and `BHOOMITRACE_VERIFY_MODE=true`,
which relaxes *only* host-property assertions (root filesystem, placeholder
domain, self-signed certificate) and prints a loud banner. TLS presence, secret
handling, and port exposure are never relaxed.

### Verified locally

| Area | Evidence |
| --- | --- |
| Static suite | `bash deploy/tests/run.sh` → **144 passed, 0 failed, 1 skipped** (the skip is a `systemctl` guard that cannot run on macOS). |
| Prod Compose renders | 6 services; only `edge` publishes ports; `api`/`worker` share one upload source; production env forced; seed behind `demo`; no interpolation warnings. |
| Preflight | Accepts a valid config; refuses `latest`, wildcard CORS, non-HTTPS origin, an origin with the wrong port, a missing certificate, and a data directory on the root filesystem. |
| Host prep | `prepare-host.sh` executed **as root** against a real Linux filesystem: created the layout with the documented modes and ownership (`postgres` 700 `70:70`, `uploads` 750 `1000:1000`, `tls`/`backups`/`state` 700 root, `logs` 750). |
| Cold start | From empty data directories: migrations applied, seed loaded synthetic data, all services healthy. |
| Real auth + upload through the edge | Logged in over TLS → `200` with a CSRF token; uploaded two synthetic PDFs → `201` each with persisted document records; the same upload without `x-csrf-token` → `403`. Evidence files present on disk. |
| Health check | All checks PASS, 0 failures: container health, migration exit 0, `/health` 200, `/health/live` 200, worker liveness, frontend SPA, edge `/healthz`, edge SPA, `/api/` proxying (401), HTTP→HTTPS 301, disk. |
| Database backup | `pg_dump` custom format, gzip, 180 TOC entries, `drizzle_migrations` present, `.sha256` + `.meta` sidecars, archive readable by `pg_restore`. |
| Evidence backup | `tar.gz` with validated entry count, checksum, and metadata. |
| Refuse-on-no-destination | A backup without `--no-upload` fails rather than silently skipping the off-host copy. |
| Restore drill | **11/11 steps PASS**: throwaway postgres, dump, archive, restore, table-by-table comparison (15 tables, 12 migrations), evidence hash comparison (2 files), API readiness/liveness/authorisation against the restored database. |
| Deploy | `deploy.sh` pulled release B, ran migrations, recreated the stack, passed the health gate, recorded `schema_changed=false`, and preserved `previous.env`. |
| Rollback | `rollback.sh` pulled the target first, rewrote only the image references, recreated api/worker/frontend/edge with `--no-deps`, passed the health check, and printed the schema warning. |
| Restore safety guards | Production restore refused without `--force-production`, without the environment sentinel, and with the wrong sentinel; scratch restore refused without a target container, with a container that is not running, with a non-identifier database name, and with a missing dump. |

### Debugging found by running it (all fixed)

Static checks alone did not catch any of these; running the stack did.

1. `compose.sh` ended with `exec compose "$@"` — `exec` cannot run a shell
   function, so every operator command failed with `compose: not found`.
2. The worker healthcheck contained a JavaScript template literal
   (`` `/proc/${pid}/cmdline` ``). Compose interpolated `${pid}` to nothing,
   silently rewriting the healthcheck to read `/proc//cmdline`. It would have
   reported the worker unhealthy forever.
3. The one-shot `migrate` service had no `depends_on` on PostgreSQL, so on a
   cold start it raced database initialisation and failed, aborting the whole
   deployment. Reproduced deterministically from empty data directories.
4. `local file="$1" out="$file.sha256"` expanded `$file` before it was assigned,
   aborting every backup under `set -u`.
5. `pg_restore` was invoked without `--username`, so it connected as the
   container's OS user (`root`), which has no database role; every restore
   failed.
6. `pg_restore --list < dump | grep -q ';'` looked correct and always failed:
   `grep -q` exits at the first match, the producer takes SIGPIPE, and
   `set -o pipefail` reports a successful check as a failure.
7. `docker compose ps --format json` emits one JSON object **per line**, not an
   array, so the deploy health-wait loop's `jq '.[]'` query matched nothing and
   timed out after 180 s on an already-healthy stack. Now centralised in
   `compose_ps_json`.
8. The optional `bt_session` cookie is `HttpOnly`, so a cookie-jar dump hides
   it behind an `#HttpOnly_` prefix — harmless, but it is why the session cookie
   does not appear in a naive listing.

Each of these now has a regression test in `deploy/tests/run.sh`, including a
fixture-driven test that the NDJSON parse works and that the previous naive form
does not.

### Not verified — no AWS access in this environment

These paths are implemented and reviewed but have never executed against real
AWS resources. There is no `aws` CLI and no credentials here.

| Item | Status |
| --- | --- |
| SSM Parameter Store / Secrets Manager fetch | **Not verified.** `fetch-secrets.sh` was only exercised for its failure path (it fails cleanly and writes nothing when AWS is unreachable). |
| S3 upload and read-back | **Not verified.** `s3_put` was never run against a bucket; `--no-upload` was used throughout. |
| S3 lifecycle / encryption / bucket policy | **Not verified.** `configure-s3-lifecycle.sh` was not run; `--dry-run` was inspected only. |
| S3 restore path | **Not verified.** The drill restores from a local dump. |
| CloudWatch log shipping and metrics | **Not verified.** No agent run; no `PutMetricData` call; `BHOOMITRACE_CLOUDWATCH_NAMESPACE` was never set. |
| CloudWatch alarms, SNS topic, notification | **Not created.** Configuration and commands only. No alert has been shown to fire. |
| Let's Encrypt issuance and renewal | **Not verified.** A self-signed certificate was used; `certbot` never ran. |
| EBS attach, mount, `fstab` persistence | **Not verified.** The script's filesystem-identity logic was exercised against a Linux bind mount, not a real EBS device. |
| systemd timers | **Not verified in situ.** Units parse and are installed by a script; `systemctl` is unavailable locally. |
| `shellcheck` / `hadolint` / `yamllint` lint | **Not run.** Not installed here. CI runs the test suite; the three new lint-style checks in `deploy/tests/run.sh` are a partial substitute. |

### Recommended before calling anything production-ready

Run, in this order, and keep the output as evidence: `fetch-secrets.sh` against
a real parameter; `backup-all.sh` to a real bucket and confirm the object with
`head-object`; `configure-s3-lifecycle.sh` and confirm the rule in the console;
a restore from the **S3 object** (not the local file); the CloudWatch agent plus
a deliberately triggered alarm that produces a real notification; and
`issue-certificate.sh` against the real hostname followed by
`health-check.sh` **without** `--insecure`.

---

## 16. Known blockers and limitations (prioritised)

1. **Everything AWS is unproven.** Backups, secrets, and monitoring are the
   parts of a deployment you discover are broken *during* an incident. Treat
   Sections 5, 6, 11 and 14 as untested until the checks above are run.
2. **No high availability.** A single instance, a single EBS volume, a single
   availability zone. Any EC2 or EBS event is downtime. There is no automatic
   recovery beyond `restart: unless-stopped`.
3. **No off-host restore has been drilled.** The restore path is proven against
   a local dump; a full "lose the instance, rebuild, restore from S3" exercise
   has not been performed. Until it is, the recovery time is unknown.
4. **Single-node PostgreSQL has no point-in-time recovery.** A dump exists at
   most once per day (the backup timer). Up to 24 hours of writes can be lost.
   WAL archiving or a managed database is the fix.
5. **Migrations never roll back.** A failed schema-changing release requires the
   restore-first procedure in Section 12.3, which means data loss back to the
   last dump. This is inherent to forward-only migrations, not to these scripts.
6. **Alerting does not exist until it is created.** `cloudwatch/alarms.md` is
   instructions, not a deployed alarm.
7. **Frontend image base is not digest-pinned**, and the CI smoke test does not
   cover authenticated, upload, or reviewer flows.
8. **Product gaps from the Phase 5 audit remain open** — no OCR, no account
   lockout, no live extraction provider call, and the extraction reviewer
   endpoints are still missing.
9. **`shellcheck` has never been run against these scripts** (it is not installed
   here). Three classes of shell bug it would have caught are now covered by
   purpose-built checks in `deploy/tests/run.sh`, but that is not the same as a
   full lint.

---

## 17. Teardown and safety notes

Nothing in this directory deletes a volume, prunes a volume, resets a database,
or removes a data directory. The operations that could destroy data are all
explicit and gated:

* `restore.sh --mode production` (three gates, Section 12.2).
* `install-systemd-units.sh --uninstall` (stops timers; leaves every file).
* `compose.sh down` (removes containers and the network; **no** `-v` flag).
* The restore drill's throwaway resources, which are always named
  `bhoomitrace-drill-*`.

To stop the stack without touching data:

```bash
cd /opt/bhoomitrace
deploy/scripts/compose.sh down          # never add -v
```

The local development stack (`docker-compose.yml`, project `bhoomitrace`) is
untouched by everything in this directory and can coexist with it.

---

## 18. Command reference

| Command | Purpose |
| --- | --- |
| `scripts/compose.sh <args>` | The only supported way to run `docker compose` against this stack. |
| `scripts/preflight.sh` | Validate configuration. Run before every deploy. |
| `scripts/prepare-host.sh [--check]` | Create/verify the EBS directory layout (root). |
| `scripts/fetch-secrets.sh` | Fetch the DB password from SSM/Secrets Manager into `env/secrets.env`. |
| `scripts/issue-certificate.sh --email A` | Obtain/replace the TLS certificate (root, port 80 required). |
| `scripts/deploy.sh [--note T] [--skip-backup] [--rollback-on-failure] [--wait-seconds N]` | Backup, pull, migrate, recreate, health-gate, record. |
| `scripts/rollback.sh [--to FILE \| --list] [--yes] [--skip-health]` | Image-only rollback. |
| `scripts/record-release.sh [--from-running] [--note T] [--keep-current]` | Record/observe releases. |
| `scripts/backup-all.sh [--label T] [--no-upload] [--db-only]` | Database + evidence backup with verification. |
| `scripts/backup-db.sh` / `scripts/backup-uploads.sh` | The individual halves of the above. |
| `scripts/restore-drill.sh [--source-dump F] [--skip-uploads] [--keep]` | Full drill against disposable resources. |
| `scripts/restore.sh --dump F [--mode production …]` | Restore (scratch by default). |
| `scripts/health-check.sh [--skip-public] [--insecure] [--base-url URL]` | Readiness, liveness, frontend, TLS edge, disk. |
| `scripts/configure-s3-lifecycle.sh [--dry-run] [--apply-encryption] [--apply-tls-only-policy]` | Bucket lifecycle, encryption, and transport policy. |
| `scripts/install-systemd-units.sh [--enable] [--uninstall]` | Install the backup/health/renewal timers. |
| `scripts/db-summary.sh (--container N \| --compose) --db N` | Print a per-table summary; used by the drill. |
| `tests/run.sh` | The verification suite described in Section 15. |

Environment variables used for local verification only — **never set these in
production**: `BHOOMITRACE_VERIFY_MODE`, `BHOOMITRACE_ALLOW_ROOT_FS`,
`BHOOMITRACE_ALLOW_NONROOT`, `BHOOMITRACE_ALLOW_MUTABLE_IMAGES`,
`BHOOMITRACE_PROJECT_NAME`, `BHOOMITRACE_STACK_ENV`, `BHOOMITRACE_SECRETS_ENV`.
Each prints a banner when active.
