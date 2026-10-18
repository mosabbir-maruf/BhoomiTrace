<div align="center">

<img src="../../frontend/public/favicon.svg" alt="BhoomiTrace" width="100" height="100" />

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

> **Guide scope:** Monitoring and alerting operations for the production deployment. For infrastructure prerequisites and deployment order, first read the [deployment runbook](../README.md); for a local developer/judge run, use the [root README](../../README.md).

This document contains the **exact commands** to turn on log shipping and create
alarms, plus the steps that prove an alert actually reaches a human.

> Reality check. Nothing in this repository creates an alarm. An alarm exists only
> after the `put-metric-alarm` call below has been made **and**
> `aws cloudwatch describe-alarms` shows it with a state. A notification exists
> only after the SNS email has actually been received. A green checkmark in this
> file is not evidence — the command output is.

## What is monitored, and where the signal comes from

| Concern | Signal | Source |
| ------- | ------ | ------ |
| Host status (instance/EC2 checks) | `AWS/EC2 StatusCheckFailed` | EC2, no agent needed |
| Disk pressure | `BhoomiTrace disk_used_percent` (`path`) | CloudWatch agent |
| Memory pressure | `BhoomiTrace mem_used_percent` | CloudWatch agent |
| Service unavailability | `BhoomiTrace HealthCheckFailure` | `health-check.sh` via systemd timer, every 5 min |
| Backup failure | `BhoomiTrace BackupFailure`, `BackupSuccess` | `backup-all.sh` via systemd timer, daily |
| Certificate expiry | `BhoomiTrace` health-check failure + `cert-renew.log` | `health-check.sh` warn, certbot timer |
| Application errors | `/aws/…/docker` (optional `awslogs` driver) | Docker containers |

The scripts publish `HealthCheckFailure`, `BackupSuccess`, and `BackupFailure`
only when `BHOOMITRACE_CLOUDWATCH_NAMESPACE` is set. The shipped systemd units set
it to `BhoomiTrace`. Local runs never attempt to reach AWS.

## 1. Notification target

```bash
REGION=ap-south-1
EMAIL=ops@example.org

TOPIC_ARN=$(aws sns create-topic --region "$REGION" --name bhoomitrace-alerts \
  --query TopicArn --output text)
echo "$TOPIC_ARN"

aws sns subscribe --region "$REGION" --topic-arn "$TOPIC_ARN" \
  --protocol email --notification-endpoint "$EMAIL"
```

**Prove it works before trusting it:** the subscription is `PendingConfirmation`
until someone clicks the link in the email. Confirm, then:

```bash
aws sns get-topic-attributes --region "$REGION" --topic-arn "$TOPIC_ARN" \
  --query 'Attributes.SubscriptionsConfirmed'
# must print "1" (not "0")
```

Send a test notification and confirm the email arrives:

```bash
aws sns publish --region "$REGION" --topic-arn "$TOPIC_ARN" \
  --subject "BhoomiTrace alert test" --message "If you can read this, alerting works."
```

## 2. Log shipping

IAM permissions required by the instance role:

```json
{
  "Effect": "Allow",
  "Action": [
    "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents",
    "logs:DescribeLogStreams", "logs:PutRetentionPolicy"
  ],
  "Resource": "arn:aws:logs:*:*:log-group:/bhoomitrace/prod/*"
}
```

Install and start the agent (Amazon Linux 2023):

```bash
sudo dnf install -y amazon-cloudwatch-agent
sudo mkdir -p /opt/aws/amazon-cloudwatch-agent/etc
sudo cp /opt/bhoomitrace/deploy/cloudwatch/amazon-cloudwatch-agent.json \
  /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
sudo systemctl status amazon-cloudwatch-agent
```

Verify (a running agent is not proof — a log event is):

```bash
sudo /opt/bhoomitrace/deploy/scripts/health-check.sh --skip-public || true
sleep 60
aws logs describe-log-streams --region ap-south-1 \
  --log-group-name /bhoomitrace/prod/health --order-by LastEventTime --descending --max-items 1
aws logs get-log-events --region ap-south-1 \
  --log-group-name /bhoomitrace/prod/health \
  --log-stream-name "$(curl -sS -H "X-aws-ec2-metadata-token: $(curl -sS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)" http://169.254.169.254/latest/meta-data/instance-id)" \
  --limit 5
```

`get-log-events` returning recent BhoomiTrace lines is the evidence. If it returns
nothing after a couple of minutes, the agent is not shipping — fix that before
relying on any alarm.

### Container logs (optional, not verified here)

The Compose stack writes bounded `json-file` logs, readable with
`deploy/scripts/compose.sh logs`. To ship them instead, add this override and
recreate the services. It requires the instance role to allow
`logs:CreateLogGroup`, `logs:CreateLogStream`, and `logs:PutLogEvents`.

```yaml
# deploy/docker-compose.logging.yml  (example; not shipped enabled)
x-awslogs: &awslogs
  driver: awslogs
  options:
    awslogs-region: ap-south-1
    awslogs-group: /bhoomitrace/prod/docker
    awslogs-create-group: "true"
    awslogs-stream: "{{.Name}}"

services:
  api: { logging: *awslogs }
  worker: { logging: *awslogs }
  frontend: { logging: *awslogs }
  edge: { logging: *awslogs }
```

```bash
deploy/scripts/compose.sh -f docker-compose.prod.yml -f docker-compose.logging.yml up -d
```

This path is **not verified in this repository** (it needs AWS credentials and a
log group). Treat the commands above as a starting point to test, not as a
tested configuration.

## 3. Alarms

```bash
REGION=ap-south-1
INSTANCE_ID=$(curl -sS -H "X-aws-ec2-metadata-token: $(curl -sS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)" http://169.254.169.254/latest/meta-data/instance-id)
TOPIC_ARN=arn:aws:sns:ap-south-1:ACCOUNT_ID:bhoomitrace-alerts
```

### 3.1 Host status

```bash
aws cloudwatch put-metric-alarm --region "$REGION" \
  --alarm-name bhoomitrace-host-status \
  --alarm-description "EC2 instance or system status check failed" \
  --namespace AWS/EC2 --metric-name StatusCheckFailed \
  --statistic Maximum --period 60 --evaluation-periods 2 \
  --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data breaching \
  --dimensions Name=InstanceId,Value="$INSTANCE_ID" \
  --alarm-actions "$TOPIC_ARN"
```

### 3.2 Disk pressure (data volume and root)

```bash
for PATH_DIM in / /srv/bhoomitrace; do
  aws cloudwatch put-metric-alarm --region "$REGION" \
    --alarm-name "bhoomitrace-disk-$(echo "$PATH_DIM" | tr '/' '_')" \
    --alarm-description "Disk usage high on $PATH_DIM" \
    --namespace BhoomiTrace --metric-name disk_used_percent \
    --statistic Maximum --period 300 --evaluation-periods 2 \
    --threshold 85 --comparison-operator GreaterThanThreshold \
    --treat-missing-data missing \
    --dimensions Name=InstanceId,Value="$INSTANCE_ID" Name=path,Value="$PATH_DIM" Name=fstype,Value=ext4 \
    --alarm-actions "$TOPIC_ARN"
done
```

Check the real dimensions before trusting the alarm — `list-metrics` shows what
the agent actually published:

```bash
aws cloudwatch list-metrics --region "$REGION" --namespace BhoomiTrace \
  --metric-name disk_used_percent
```

If the `fstype` or `path` dimension differs from the alarm, the alarm will sit in
`INSUFFICIENT_DATA` forever. Align them.

### 3.3 Service unavailability

Published by `health-check.sh` every 5 minutes.

```bash
aws cloudwatch put-metric-alarm --region "$REGION" \
  --alarm-name bhoomitrace-health-check \
  --alarm-description "Health check reported failures" \
  --namespace BhoomiTrace --metric-name HealthCheckFailure \
  --statistic Maximum --period 300 --evaluation-periods 2 \
  --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data breaching \
  --dimensions Name=InstanceId,Value="$INSTANCE_ID" \
  --alarm-actions "$TOPIC_ARN"
```

> `treat-missing-data breaching` is deliberate. If the health timer itself stops
> running, "no data" is the failure, and a `notBreaching` alarm would stay green
> while the host was silent.

### 3.4 Backup failure

Published once per day, so the period is one day and missing data is treated as
breaching for the same reason.

```bash
aws cloudwatch put-metric-alarm --region "$REGION" \
  --alarm-name bhoomitrace-backup-failure \
  --alarm-description "Scheduled backup did not succeed" \
  --namespace BhoomiTrace --metric-name BackupFailure \
  --statistic Maximum --period 86400 --evaluation-periods 1 \
  --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching \
  --dimensions Name=InstanceId,Value="$INSTANCE_ID" \
  --alarm-actions "$TOPIC_ARN"
```

`notBreaching` here because a brand-new host legitimately has no backup metric
yet; `BackupSuccess`/`BackupFailure` are both published on every run, so a silent
timer is caught by 3.3 instead.

### 3.5 Memory pressure (optional)

```bash
aws cloudwatch put-metric-alarm --region "$REGION" \
  --alarm-name bhoomitrace-memory \
  --namespace BhoomiTrace --metric-name mem_used_percent \
  --statistic Maximum --period 300 --evaluation-periods 2 \
  --threshold 85 --comparison-operator GreaterThanThreshold \
  --treat-missing-data missing \
  --dimensions Name=InstanceId,Value="$INSTANCE_ID" \
  --alarm-actions "$TOPIC_ARN"
```

## 4. Proving that an alarm fires

Creating an alarm is not the same as receiving an alert. Do all four steps.

**Step 1 — the alarm exists and has a state.**

```bash
aws cloudwatch describe-alarms --region "$REGION" \
  --alarm-names bhoomitrace-health-check \
  --query 'MetricAlarms[0].{Name:AlarmName,State:StateValue,Metric:MetricName,Actions:AlarmActions}'
```

**Step 2 — force it into ALARM without waiting for the real condition.** This
tests the notification path end to end.

```bash
aws cloudwatch set-alarm-state --region "$REGION" \
  --alarm-name bhoomitrace-health-check \
  --state-value ALARM \
  --state-reason "manual delivery test"

# Wait for the SNS email to arrive, then clear it:
aws cloudwatch set-alarm-state --region "$REGION" \
  --alarm-name bhoomitrace-health-check \
  --state-value OK \
  --state-reason "delivery test complete"
```

**Step 3 — produce a real signal and watch the state change.** For the backup
alarm, publish the metric the real script would publish on failure:

```bash
aws cloudwatch put-metric-data --region "$REGION" \
  --namespace BhoomiTrace --metric-name BackupFailure \
  --value 1 --unit Count \
  --dimensions Name=InstanceId,Value="$INSTANCE_ID"

watch -n 30 aws cloudwatch describe-alarms --region "$REGION" \
  --alarm-names bhoomitrace-backup-failure \
  --query 'MetricAlarms[0].StateValue' --output text
```

Then restore a truthful value:

```bash
aws cloudwatch put-metric-data --region "$REGION" \
  --namespace BhoomiTrace --metric-name BackupFailure \
  --value 0 --unit Count \
  --dimensions Name=InstanceId,Value="$INSTANCE_ID"
```

**Step 4 — verify the log-based evidence path.** Run the health check with the
public checks skipped, break something harmless (for example
`deploy/scripts/compose.sh stop worker`) and confirm (a) the script exits non-zero,
(b) `HEALTH RESULT: FAILURE` appears in `/srv/bhoomitrace/logs/health.log`, (c) the
same line appears in the `/bhoomitrace/prod/health` log group, and (d) the
`bhoomitrace-health-check` alarm moves to `ALARM`. Then
`deploy/scripts/compose.sh start worker` and confirm it returns to `OK`.

## 5. Alarm state that this repository does **not** create

To be explicit, so the deployment is not described as more protected than it is:

* No SNS topic, subscription, or alarm is created by `deploy/` scripts or by CI.
* No CloudWatch agent installation is performed automatically.
* No dashboards, composite alarms, or on-call rotation exist.
* Container-log shipping via the `awslogs` driver is documented but unverified.
* Alarms only exist on the single host they are created for. A replaced instance
  needs the alarms (and the SNS subscription confirmation) re-created or moved to
  an ASG/CloudFormation stack.
