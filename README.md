# app-repo — application code and its security pipeline

[![security](https://github.com/Shadikul-Islam/DevSecOps/actions/workflows/security.yml/badge.svg)](https://github.com/Shadikul-Islam/DevSecOps/actions/workflows/security.yml)
[![api-service-ci](https://github.com/Shadikul-Islam/DevSecOps/actions/workflows/api-service-ci.yml/badge.svg)](https://github.com/Shadikul-Islam/DevSecOps/actions/workflows/api-service-ci.yml)
[![worker-service-ci](https://github.com/Shadikul-Islam/DevSecOps/actions/workflows/worker-service-ci.yml/badge.svg)](https://github.com/Shadikul-Islam/DevSecOps/actions/workflows/worker-service-ci.yml)

Two small Node services and the CI pipeline that guards them. The services exist to
give the pipeline something real to protect: a REST API, a background worker, a
Postgres schema, and an end-to-end test — deliberately minimal, so the interesting
part of this repo is everything around them.

This is **1 of 4 repos** in a DevSecOps platform build. Infrastructure
(`infra-repo`), GitOps/cluster config (`gitops-repo`), and documentation
(`platform-docs`) are separate repositories — see
[Why a polyrepo](#why-a-polyrepo-and-not-a-monorepo).

**Contents**

- [What this repo demonstrates](#what-this-repo-demonstrates)
- [The application](#the-application)
- [The security pipeline](#the-security-pipeline)
- [Design decisions and why](#design-decisions-and-why)
- [How each control was verified](#how-each-control-was-verified)
- [Incident response](#incident-response)
- [Quickstart](#quickstart)
- [Repo layout](#repo-layout)
- [Roadmap and known gaps](#roadmap-and-known-gaps)
- [Not in this repo, by design](#not-in-this-repo-by-design)

---

## What this repo demonstrates

| Area | What is actually implemented |
|---|---|
| **Secret scanning** | gitleaks at two layers — a local pre-commit hook and an unbypassable CI job scanning full commit history |
| **Enforcement** | A GitHub ruleset makes the scan a required status check; a red scan disables the merge button |
| **Supply-chain hardening** | Every GitHub Action pinned to an immutable commit SHA; the gitleaks binary sha256-verified before execution, failing closed |
| **Pipeline structure** | The scan is a reusable workflow; service builds declare `needs: secret-scan`, so no image is built from a rejected commit |
| **Findings as data** | Results published as SARIF to GitHub code scanning — deduplicated, auto-resolving, annotated inline on the PR diff |
| **Container hygiene** | Multi-stage builds, pinned base image, non-root runtime user, `HEALTHCHECK`, `.dockerignore` |
| **Operability** | Structured JSON logs with request correlation, Prometheus metrics, liveness and readiness probes on both services |
| **Dependency management** | Lockfile-exact installs (`npm ci`), Renovate for grouped, reviewable upgrade PRs |

Every control below was **proven able to fail before it was trusted green** — see
[How each control was verified](#how-each-control-was-verified).

---

## The application

| Component | Stack | Responsibility |
|---|---|---|
| `api-service` | Node 20 + Express | REST API for `records`; health, readiness, metrics |
| `worker-service` | Node 20 | Polls `records`, drives `pending` → `done` / `failed` |
| `db/init.sql` | Postgres 16 | `records` table, plus a partial index on `status='pending'` |
| `tests/e2e` | `node:test` | End-to-end smoke test against the running stack |

### API

| Method | Path | Description |
|---|---|---|
| `POST` | `/records` | Body `{ "email": "string" }` → `201` with the created record (`status: pending`) |
| `GET` | `/records/:id` | The record, or `404` |
| `GET` | `/healthz` | Liveness — process is up |
| `GET` | `/readyz` | Readiness — Postgres is reachable |
| `GET` | `/metrics` | Prometheus metrics |

The worker exposes only `/healthz`, `/readyz`, `/metrics` — no business API.

### Service-to-service communication

The two services talk through Postgres, using
`SELECT ... FOR UPDATE SKIP LOCKED` rather than a message queue. That one clause buys
the property that actually matters here: **multiple worker replicas never
double-process a row.** A row already locked by another replica is skipped instead of
blocked on, so replicas claim disjoint batches without coordination.

The trade-off is explicit: each batch is claimed and completed in a single
transaction, holding row locks for the batch's duration. That is fine at this scale.
A higher-throughput design would claim rows into an intermediate `processing` state
and commit immediately — noted as a known future change, not an oversight.

### Runtime hardening

Both images are multi-stage: a `deps` stage installs production-only modules with
`npm ci`, and the final stage copies those plus `src`. All dependencies are pure
JavaScript, so `node:20.18.1-alpine` needs no build toolchain and the final images
land at roughly 140 MB. Each container runs as an unprivileged `nodeapp` user
(`uid=100`), not root, and carries a `HEALTHCHECK`. Base image tags, npm packages,
and compose images are all pinned so that upgrades arrive as reviewed Renovate PRs
rather than silently.

---

## The security pipeline

Two layers scan for committed secrets. The local one is fast and skippable; the CI
one is the gate.

```
 developer machine                    GitHub pull request
┌───────────────────────┐            ┌────────────────────────────────────┐
│ git commit            │            │ security / secret-scan      ← REQUIRED
│  └─ pre-commit        │            │      gitleaks git, full history    │
│      gitleaks         │  push ──▶  │      → SARIF → code scanning       │
│      hadolint         │            │                                    │
│      hygiene hooks    │            │ api-service-ci                     │
│                       │            │      secret-scan ──▶ build         │
│ bypassable:           │            │ worker-service-ci                  │
│   git commit          │            │      secret-scan ──▶ build         │
│     --no-verify       │            │                                    │
└───────────────────────┘            │ not bypassable                     │
                                     └────────────────────────────────────┘
```

### Layer 1 — local pre-commit hooks

`.pre-commit-config.yaml` runs gitleaks, hadolint, and hygiene checks on every
`git commit`. Install once per clone:

```bash
pip install pre-commit        # or: uv tool install pre-commit
pre-commit install
pre-commit run --all-files    # first run: existing files aren't staged, so check them explicitly
```

The gitleaks hook scans **staged changes only** (`gitleaks protect --staged`), which
catches a secret before it ever enters history — the cheapest possible place to catch
it. It is skippable with `git commit --no-verify`, which is exactly why the same class
of scan runs again in CI, where it cannot be skipped.

### Layer 2 — CI secret scanning

[`.github/workflows/security.yml`](.github/workflows/security.yml) runs `gitleaks git`
over the **full commit history** on every push to `main` and every pull request.

```yaml
- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
  with:
    fetch-depth: 0

- name: Install gitleaks
  run: |
    set -euo pipefail
    curl -sSL --fail "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" -o gitleaks.tar.gz
    echo "${GITLEAKS_SHA256}  gitleaks.tar.gz" | sha256sum --check --strict -
    tar -xzf gitleaks.tar.gz gitleaks

- name: Scan git history for secrets
  run: ./gitleaks git --redact --verbose --exit-code 1 --report-format sarif --report-path gitleaks.sarif
```

### Layer 3 — enforcement

A GitHub **ruleset** on `main` turns the scan from advice into a gate:

- Require a pull request before merging
- Require status checks to pass — **`secret-scan`**
- Require code scanning results
- Block force pushes
- Restrict deletions
- Bypass list left **empty**

Without the ruleset, a red PR still merges. The ruleset is what makes the check mean
something.

### Layer 4 — build gate

`security.yml` is a **reusable workflow** (`on: workflow_call`). Both service
pipelines call it and depend on it:

```yaml
jobs:
  secret-scan:
    uses: ./.github/workflows/security.yml
    permissions:
      contents: read
      security-events: write
    with:
      skip_upload: true

  build:
    needs: secret-scan
    ...
```

No image is built from a commit the scan has already rejected. Today those images go
nowhere, so this saves runner minutes; once they are pushed to a registry, it is the
difference between a rejected commit and a published artifact.

---

## Design decisions and why

**No `paths:` filter on the security workflow.** The service workflows are
path-filtered; the security workflow deliberately is not. Secrets can land in any
file, and a required check whose workflow never runs sits **permanently pending** —
blocking every PR that happens to touch nothing it watches.

**`fetch-depth: 0` is required, not an optimisation.** `actions/checkout` clones
shallow by default. The failure case is precise: a secret **committed and later
deleted** leaves a clean working tree and a dirty history. Measured on a throwaway
repo — shallow clone scanned 0 commits and exited 0; full clone found the leak and
exited 1. The default configuration reports clean on a repository that is not.

**`--redact` is mandatory.** CI logs are visible to everyone with read access and are
retained. An unredacted finding would broadcast the secret further than the commit
that leaked it did.

**Actions pinned to commit SHAs, not tags.** A tag is a mutable pointer; it can be
repointed at different code with nothing changing in this repo — the mechanism behind
the 2025 `tj-actions/changed-files` compromise. `git grep 'uses:.*@v[0-9]'` over
`.github/workflows/` returns nothing. One subtlety: an **annotated** tag resolves to a
tag object, not a commit, and must be dereferenced before pinning.

**The gitleaks download is checksum-verified.** That binary runs unsandboxed with
repository access; an unverified download is a direct path into the pipeline. A
mismatch fails the step, so the pipeline fails closed rather than scanning with an
unknown binary.

**Callers pass `skip_upload: true`.** Two SARIF uploads under one `category` for the
same commit read as competing analyses of the same tool and the alert list
flip-flops. The called run is a **gate**; the standalone run is the **reporter**. The
flag is implemented as `if: always() && !inputs.skip_upload` — `inputs` is empty on
push and pull_request events, so the default falls open only in the safe direction.

**`security-events: write` is granted on the calling job, not workflow-wide.** The
`build` job keeps `contents: read`. Two lessons came out of getting this wrong,
recorded below.

### Two failure modes worth knowing

**A called workflow that declares more permissions than the caller grants fails
before any job starts.** Both service pipelines showed *Startup failure* with no
duration. The check is **static** — it fired even though `skip_upload: true` meant
the permission would never be used. Reusable workflows are validated against what
they *declare*, not what they execute.

**A startup failure is invisible to branch protection.** No jobs means no check runs,
which means branch protection has nothing to evaluate: the merge button stayed green
while two workflows were completely broken. Required checks are safe here — a
required check that never reports blocks on `Expected — waiting for status` — but
**non-required checks fail open.** This is the same hazard as the `paths:` filter
problem, arriving from the other direction, and it is the reason the primary gate is
unfiltered and required.

---

## How each control was verified

A green pipeline proves nothing on its own. Each control was made to fail first.

| Control | How it was proven | Result |
|---|---|---|
| Local pre-commit hook | Committed a file with a realistic AWS key | Commit blocked, no commit object created |
| CI secret scan | Pushed the same key using `--no-verify` | Workflow red, secret detected |
| Required status check | Opened a PR with the red scan | Merge button disabled |
| `fetch-depth: 0` | Committed a secret, then deleted the file | Shallow: 0 commits, exit 0. Full: leak found, exit 1 |
| Checksum verification | Corrupted the downloaded tarball | `sha256sum` FAILED, step exited 1 |
| SARIF reporting | Merged the hardened workflow | `gitleaks` listed under Security → Code scanning |
| Build gate | Inspected the run graph | `secret-scan → build` edge present in both pipelines |
| Positive path | Opened a clean PR | All checks green, merged normally |
| Application flow | `node --test e2e/` | 4/4 pass — create → `pending` → `done`, 404, both probe sets |

One detail from the first attempt: the initial canary used
`AKIAIOSFODNN7EXAMPLE`, which gitleaks **allowlists** because it appears throughout
AWS's own documentation. A test that passes because the tool ignored the input is not
a test. It was replaced with realistic randomised keys.

---

## Incident response

**Deleting the file does not fix a leaked secret.** gitleaks scans *commits*, not the
working tree. Once a secret has been pushed anywhere, treat it as compromised.

1. **Rotate the credential.** Always first.
2. Then remove it from history.
3. Then confirm the scan is clean.

This repo learned it the hard way: a canary PR carrying a fake AWS key was merged to
`main` before protection existed. Deleting the file on a later branch changed nothing
— the commit was still there. It was resolved with `git reset --hard` and a force
push, which was safe **only** because nothing sat above it, the repo is single-author,
the secret was fake, and no protection was in place yet. On a shared branch, rewriting
history is a coordination problem, not a command.

For findings that are genuinely not secrets, add the reported fingerprint to
`.gitleaksignore` rather than weakening `--exit-code` — that suppresses one finding
while the rest of the scan keeps enforcing.

---

## Quickstart

Requires Docker and Docker Compose. Running the e2e test from the host also needs
Node ≥ 20 — or run it in a container, shown below.

```bash
cp .env.example .env              # demo credentials only
docker compose up -d --build
docker compose ps                 # wait for all three to report healthy
```

### Try it

```bash
curl -s -X POST localhost:3000/records \
  -H 'Content-Type: application/json' \
  -d '{"email":"a@b.com"}'
# → 201 {"id":1,"email":"a@b.com","status":"pending",...}

curl -s localhost:3000/records/1  # 'pending', then 'done' after ~5-7s

curl -s localhost:3000/healthz
curl -s localhost:3000/metrics | head
curl -s localhost:3001/healthz    # worker
```

### Run the end-to-end test

```bash
cd tests && npm run test:e2e      # or from the repo root: npm run test:e2e
```

Without Node 20 locally, run it inside a container on the compose network:

```bash
docker run --rm --network app_default \
  -e API_URL=http://api-service:3000 \
  -e WORKER_URL=http://worker-service:3001 \
  -v "$PWD/tests":/tests -w /tests node:20.18.1-alpine \
  node --test e2e/
```

Compose derives the network name from this directory (`app_default`) — run
`docker network ls` to confirm if yours differs.

### Tear down

```bash
docker compose down -v            # -v also drops the postgres volume
```

---

## Repo layout

```
api-service/        Express API      (src/, Dockerfile, .dockerignore)
worker-service/     Poll-loop worker (src/, Dockerfile, .dockerignore)
db/init.sql         Postgres schema
tests/e2e/          End-to-end smoke test
docker-compose.yml  Local dev stack — never leaves this repo
.github/workflows/  security.yml (secret scanning, reusable) + per-service CI
.pre-commit-config.yaml   Local hooks: gitleaks, hadolint, hygiene
renovate.json       Grouped, pinned dependency update PRs
```

---

## Roadmap and known gaps

Listed openly — an accurate picture of what is not yet done is more useful than a
clean-looking one.

**Next**

- **Dependency and image scanning** — `npm audit` over the lockfiles, plus Trivy
  against the built images for OS-package and module CVEs, publishing SARIF under
  `category: trivy`. The two are complementary: `npm audit` reads the dependency
  tree, Trivy inspects the artifact that actually ships, including base-image
  packages that `npm audit` never sees.
- **SBOM and provenance** — generate an SBOM per image, sign images and attach
  attestations.
- **Distroless base images** — remove the shell and package manager from the runtime
  layer.

**Known gaps**

- **gitleaks version drift.** `.pre-commit-config.yaml` pins `v8.21.2` while
  `security.yml` pins `8.24.3`, and the workflow comment claims the two are kept in
  step. A commit passing the local hook can still fail CI on a rule added in between.
- **No unit tests** beyond the e2e smoke flow.
- **Merged branches are not auto-deleted** — enabling *Settings → General →
  Automatically delete head branches* removes the manual step.

---

## Not in this repo, by design

Kubernetes manifests, Terraform, Helm/Kustomize, and ArgoCD configuration live in
`infra-repo` and `gitops-repo`. `docker-compose.yml` here is local development only
and never leaves this repo.

### Why a polyrepo and not a monorepo

The split is a **least-privilege and blast-radius** decision, not an organisational
one. Application developers never need write access to infrastructure or cluster
configuration, and ArgoCD's source of truth (`gitops-repo`) is written only by CI or
by a reviewed pull request. Collapsing all four into one repository would mean one
set of permissions covering application code, cloud infrastructure, and the live
cluster state — and one compromised token reaching all three.
