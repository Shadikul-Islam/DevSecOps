# app-repo — Phase 0

Application code for **app-repo**, 1 of 4 repos in a DevSecOps portfolio project
(polyrepo). This repo holds application code, Dockerfiles, and CI workflows only.
Infra (`infra-repo`), GitOps (`gitops-repo`), and docs (`platform-docs`) live in
separate repos and are built in later phases. The cross-repo build log and full
project context live in the workspace-root `CLAUDE.md` (one level up, outside this
repo) — see it there if you're working in the `devsecops/` workspace.

## What's here (Phase 0)

| Component | Stack | Responsibility |
|-----------|-------|----------------|
| `api-service` | Node 20 + Express | REST API for `records`; health/readiness/metrics |
| `worker-service` | Node 20 | Polls `records`, processes `pending` → `done`/`failed` |
| `db/init.sql` | Postgres 16 | Single `records` table + init |
| `tests/e2e` | `node:test` | End-to-end smoke test against the running stack |

Communication is **DB-based polling** using `SELECT ... FOR UPDATE SKIP LOCKED`
(no message queue in Phase 0). See the workspace-root `CLAUDE.md` for the rationale.

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/records` | Body `{ "email": "string" }` → `201` with the created record (`status: pending`) |
| `GET`  | `/records/:id` | The record, or `404` |
| `GET`  | `/healthz` | Liveness (process up) |
| `GET`  | `/readyz` | Readiness (can reach Postgres) |
| `GET`  | `/metrics` | Prometheus metrics |

The worker exposes only `/healthz`, `/readyz`, `/metrics` (no business API).

## Quickstart

Requires Docker + Docker Compose. Running the e2e test from the host also needs
Node ≥ 20 (or run it in a container — see below).

```bash
# 1. Configure local env (demo credentials only)
cp .env.example .env

# 2. Build and start the stack
docker compose up -d --build     # or: docker-compose up -d --build

# 3. Wait until both services report healthy
docker compose ps
```

### Try it manually

```bash
# Create a record
curl -s -X POST localhost:3000/records \
  -H 'Content-Type: application/json' \
  -d '{"email":"a@b.com"}'
# → 201 {"id":1,"email":"a@b.com","status":"pending",...}

# Fetch it — pending at first, 'done' after the worker picks it up (~5–7s)
curl -s localhost:3000/records/1

# Probes / metrics
curl -s localhost:3000/healthz
curl -s localhost:3000/readyz
curl -s localhost:3000/metrics | head
curl -s localhost:3001/healthz   # worker
```

### Run the e2e test

Proves the full flow: create → `pending` → worker → `done`, plus health/metrics.

```bash
# From the host (Node >= 20)
cd tests && npm run test:e2e
# or from the repo root:  npm run test:e2e
```

If you don't have Node 20 locally, run it inside a container on the compose
network (no host ports needed):

```bash
docker run --rm --network app_default \
  -e API_URL=http://api-service:3000 \
  -e WORKER_URL=http://worker-service:3001 \
  -v "$PWD/tests":/tests -w /tests node:20.18.1-alpine \
  node --test e2e/
```

(Compose derives the network name from this directory — `app_default`.
Run `docker network ls` to confirm if your project dir differs.)

### Tear down

```bash
docker compose down -v    # -v also drops the postgres volume
```

## Security

Two layers scan for committed secrets — one local, one in CI. The local one is
fast and skippable; the CI one is the gate.

### Local: pre-commit hooks

`.pre-commit-config.yaml` runs gitleaks, hadolint, and basic hygiene checks on
every `git commit`. Install once per clone:

```bash
pip install pre-commit      # or: uv tool install pre-commit
pre-commit install
pre-commit run --all-files  # first run: existing files aren't staged, so check them explicitly
```

The gitleaks hook scans staged changes only (`gitleaks protect --staged`), which
catches a secret before it ever reaches history. It can be skipped with
`git commit --no-verify` — which is exactly why the same scan also runs in CI,
where it cannot be bypassed.

### CI: secret scanning

`.github/workflows/security.yml` runs `gitleaks git` over the full commit history
on every push to `main` and every pull request. It is deliberately **not**
path-filtered: secrets can land in any file, and a filtered workflow would leave
a required check permanently pending on PRs that touch nothing it watches.

`fetch-depth: 0` on checkout is required, not an optimisation. The default
shallow clone hides a secret that was committed and later deleted — the file is
gone from the tree, the secret is still in history, and the scan reports clean.

`--redact` is likewise mandatory: run logs are visible to anyone with read access
and are retained, so an unredacted finding would spread the secret further than
the commit did.

### Enforcement

`secret-scan` is a required status check on `main`, together with "require a pull
request before merging", "require branches to be up to date", "block force
pushes", and "restrict deletions". A red scan disables the merge button. Without
the ruleset the check is only advice — a red PR stays merge-able.

### If a secret is found

Deleting the file does not fix it. The secret remains in history, and once it has
been pushed anywhere it must be treated as compromised. **Rotate the credential
first**; cleaning history is the second step, never the first.

For findings that are genuinely not secrets, add the reported fingerprint to
`.gitleaksignore` rather than relaxing `--exit-code` — that keeps the rest of the
scan enforcing.

## Repo layout

```
api-service/       Express API (src/, Dockerfile, .dockerignore)
worker-service/    Poll-loop worker (src/, Dockerfile, .dockerignore)
db/init.sql        Postgres schema
tests/e2e/         End-to-end smoke test
docker-compose.yml Local dev stack (never leaves this repo)
.github/workflows/ security.yml (secret scanning) + per-service CI
```

## Not in this repo (by design)

Kubernetes manifests, Terraform, Helm/Kustomize, and ArgoCD config live in
`infra-repo` / `gitops-repo`. Do not add them here.
