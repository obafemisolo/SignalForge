# SignalForge deployment guide

This document describes the supported deployment shape and the smallest credible
AWS production setup. Terraform is intentionally out of scope; these steps are
an architecture and operations guide for a later infrastructure implementation.

## Configuration by environment

| Environment | Runtime                                           | Data                                          | External integrations                      |
| ----------- | ------------------------------------------------- | --------------------------------------------- | ------------------------------------------ |
| Development | Docker Compose or local Node processes            | Local PostgreSQL and Redis volumes            | Optional LLM key in an uncommitted `.env`  |
| Staging     | Small ECS services or one EC2 host                | Isolated RDS and ElastiCache instances        | Separate LLM key and domains               |
| Production  | ECS Fargate API and worker services behind an ALB | Multi-AZ RDS PostgreSQL and ElastiCache Redis | Secrets Manager, ACM, Route 53, CloudWatch |

Keep `DATABASE_URL`, `REDIS_URL`, and `LLM_API_KEY` environment-specific. Never
copy a development `.env` into an image or commit a populated environment file.
Staging and production should use Secrets Manager or SSM Parameter Store
injected by the task definition.

## Release and migration sequence

1. Build and scan the API, worker, and web images from the same commit.
2. Push immutable image tags containing the commit SHA to ECR.
3. Run the Prisma migration as a one-off release task using the migration target
   of the API image:

   ```bash
   docker build --target migrate -f apps/api/Dockerfile -t signalforge-migrate:$GIT_SHA .
   docker run --rm --env-file production.env signalforge-migrate:$GIT_SHA
   ```

   Locally, the equivalent Compose command is
   `docker compose --profile migrate run --rm migrate`. In ECS, run the
   migration target as a one-off task with the production `DATABASE_URL` secret
   and the same network security group as the service.

4. Deploy the API and worker services, then deploy web with the API service DNS
   name configured as `SIGNALFORGE_API_URL`.
5. Wait for `/health/ready`, worker `/health/ready`, and queue depth metrics to
   become healthy before shifting traffic.

Migrations are deliberately not executed automatically by every container:
parallel task starts must not race migrations, and rollback ownership should be
explicit in the release pipeline.

## Cost-conscious AWS architecture

The recommended production topology is:

```text
Route 53 -> ACM certificate -> Application Load Balancer
                              -> ECS Fargate API service
                              -> ECS Fargate web service

ECS worker service -> ElastiCache Redis
ECS API/worker      -> RDS PostgreSQL
All services        -> CloudWatch logs and metrics
Secrets             -> Secrets Manager or SSM Parameter Store
```

Use private subnets for RDS, Redis, and ECS tasks; only the ALB is public.
Security groups should allow the API and worker to reach database and Redis
ports, while RDS and Redis accept traffic only from the ECS task security group.
Route 53 provides the application DNS name and ACM terminates TLS at the ALB.

The lowest-cost credible MVP is one small EC2 instance running Docker Compose
with automated backups to an external object store, plus a managed RDS instance.
This reduces control-plane and load-balancer cost but has a larger failure
domain and requires the team to own host patching. For a more durable MVP, use
one small ECS Fargate API task and one worker task, single-AZ small RDS and
ElastiCache plans, and an ALB only when a stable public endpoint is needed.
Enable Multi-AZ and multiple tasks after traffic or availability requirements
justify their cost.

Primary cost drivers are Fargate vCPU/memory-hours, ALB hourly and LCU usage,
RDS instance/storage/backup/Multi-AZ, ElastiCache node-hours, NAT gateways,
CloudWatch log ingestion/retention, and LLM token usage. NAT gateways can be a
surprisingly large fixed cost for a small deployment; a single EC2 MVP or VPC
endpoints should be considered when appropriate.

## Scaling boundaries

- Scale API tasks on ALB request count, p95 latency, and CPU. Keep API tasks
  stateless.
- Scale workers on BullMQ queue depth and oldest-job age. Increase source-fetch
  concurrency only within per-domain limits and upstream terms of service.
- Scale PostgreSQL vertically first; add read replicas only for measured read
  pressure. Keep connection pool limits below the RDS connection budget.
- Scale Redis vertically and retain bounded jobs. Do not treat Redis as the
  durable source of research state.
- Cap LLM concurrency and token budgets before adding worker capacity; cost and
  provider rate limits are the practical boundary.

## Production deployment checklist

- [ ] Pin image tags to a commit SHA and scan them before release.
- [ ] Store all secrets in Secrets Manager or SSM; verify no secrets are in task
      definitions, logs, or image layers.
- [ ] Provision private subnets, security groups, RDS backups, and Redis
      authentication/encryption.
- [ ] Apply Prisma migrations as a one-off release task.
- [ ] Configure ALB health checks for `/health/ready` and HTTPS redirects.
- [ ] Set `SIGNALFORGE_API_URL` to the internal API service URL for web tasks.
- [ ] Configure CloudWatch retention, alarms, and worker heartbeat monitoring.
- [ ] Set queue retention, worker concurrency, extraction limits, and LLM cost
      ceilings for the environment.
- [ ] Test dead-letter handling, source failures, database restore, and a worker
      restart before launch.
- [ ] Verify Route 53 DNS, ACM certificate renewal, CORS/security headers, and
      rate limits.
- [ ] Document the rollback image and migration rollback procedure.

See [`docs/runbook.md`](runbook.md) for incident response procedures.
