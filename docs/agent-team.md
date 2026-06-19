# Ceylon Hop — Agent Team Operating Manual

Status: v1 · Last updated: 2026-06-17 · Companions: [`backend-spec.md`](./backend-spec.md)
(the *why*), [`build-plan.md`](./build-plan.md) (the *what/how*). This doc is the *who and
how-we-work*.

The goal this is optimised for: **build the backend to completion with minimal human
intervention, no drift, no scope creep, fully tested, token-efficient, and without
changing the existing UI or functionality.**

---

## 0. How the goals map to mechanisms

| Your goal | The mechanism that guarantees it |
|---|---|
| No drift | Tests-first contracts + a Reviewer in a separate context + CI as the judge |
| No scope creep | The plan is frozen; only the Orchestrator assigns work; ambiguity escalates to you |
| Fully tested | A step isn't "done" until its tests exist and CI is green |
| No UI/functionality change | CI path-guard + `CODEOWNERS` lock the site files; backend lives only in `api/` |
| Token-efficient | One step = one fresh, scoped context; retry cap; model tiering; no exploration |
| Long-term view | Architecture frozen up front as spec + ADRs; interfaces pinned; vertical slices |
| Minimal intervention | Human signs off at **every** milestone; within a milestone, automated gates (CI + Reviewer) do the rest |

The throughline: **push the burden off "trusting the agent" and onto structure that
can't drift.**

---

## 1. Core principle — split by duty, slice vertically

Do **not** mirror a human org chart (front-end / back-end / DB / API / QA engineers).
That maximises handoff seams (where agents drift) and forces parallelism onto a
dependency chain (where tokens burn). Instead:

- **Split by duty:** who *decides scope* (Orchestrator) vs who *implements* (Builder) vs
  who *verifies* (Reviewer). Separation of duties is the anti-drift firewall.
- **Slice vertically:** each unit of work is one build-plan step taken **end-to-end
  through every layer** (schema → endpoint → tests) in a single coherent context — no
  FE↔BE↔DB handoff to drift through.
- **Disciplines become artifacts, not agents:** Architect → the spec + ADRs (frozen).
  API design → pinned interface/contract. DBA → schema-first migrations + generated
  types. QA → tests + Reviewer + CI.

---

## 2. The team (Option C: Orchestrator · Builder · Reviewer + CI)

Three roles plus CI. CI is not an agent — it is the non-negotiable automated gate.

### Orchestrator (never writes code)
- **Mandate:** own the spec + build-plan; select the lowest-numbered step whose deps are
  merged; brief one Builder with a **scoped** context (just that step's ticket + the one
  interface it touches); decide what — if anything — is safe to parallelise; hold scope.
- **Must not:** write or edit code; change the plan, spec, or interfaces; let a step
  proceed if ambiguous — it **escalates to the human** instead.
- **Model:** strong (judgment role).

### Builder (one step, fresh context, then discarded)
- **Mandate:** implement exactly one step's "Build" list; **write that step's tests
  first** where practical; open a PR; stop.
- **Must not:** touch files outside the step's scope; call a real external service;
  change an interface; add a dependency or invent work. Any of these → **stop and ask**.
- **Context:** the step ticket + named interfaces only — not the whole repo or spec.
- **Model:** cheaper for mechanical steps, strong for design-heavy steps (Orchestrator
  decides).

### Reviewer (independent context — does not trust the Builder's story)
- **Mandate:** verify the PR against the step's Definition of Done (§7): only listed
  files changed? tests present and meaningful (would fail if behaviour broke)? no UI or
  functionality touched? no scope creep? interfaces unchanged? Approve or bounce with
  specific reasons.
- **Must not:** implement features or "fix it themselves" beyond trivial notes.
- **Model:** strong.

### CI (the hard gate — runs on every PR)
typecheck · lint · all tests · **changed-paths guard** (fails if anything outside
`api/`, `docs/`, `.github/` changes during backend phases) · architectural lint
(forbidden imports). A PR cannot merge unless CI is green **and** the Reviewer approved.

> Scale note: add discipline/surface specialists **only** when genuinely parallel,
> separable tracks appear later (e.g. ops dashboard vs WhatsApp vs reporting). Not before.

---

## 3. The operating loop (one step)

1. **Select** — Orchestrator picks the next eligible step.
2. **Brief** — Orchestrator gives the Builder a fresh, scoped context.
3. **Build (test-first)** — Builder writes tests, implements, runs `npm run check`,
   opens a PR with the DoD checklist filled in.
4. **CI** — automated gates run; red = back to Builder (max 2 attempts, then escalate).
5. **Review** — Reviewer (fresh context) checks the DoD; bounces or approves.
6. **Human gate** — at the **end of every milestone**, the founder runs that milestone's
   human checkpoint(s) + a quick end-to-end smoke test and signs off before the next
   milestone starts. **This never relaxes.** (M1, M6, M7 are the heaviest, launch-critical
   gates — but *every* milestone gets your sign-off.)
7. **Merge** — squash-merge to `main`; deploy to staging (skeleton is live from day one).

---

## 4. Frozen contracts (immutable without a dedicated decision)

These are decided once and held still; changing one is its own deliberate step, not a
side effect:

- **Architecture & stack** — `backend-spec.md` + the pinned stack in `build-plan.md`.
- **Interfaces** — every adapter/function signature once a step defines it.
- **Schema** — migrations are forward-only; types are generated from them.
- **The build-plan steps** — agents execute them; they do not rewrite them.

Any need to change a frozen contract → **stop and ask the human** + record an ADR (§6).

---

## 5. Token economy & earned autonomy

- **Fresh, scoped context per step** — the single biggest lever for both cost and drift.
  Nothing accumulates; nothing wanders.
- **No speculative exploration** — the plan removes the need to "go figure it out."
- **Model tiering** — strong models for Orchestrator/Reviewer and design-heavy steps;
  cheaper for mechanical ones.
- **Retry cap** — a step that fails twice is **escalated**, never thrashed.
- **Progressive autonomy ladder** — this governs **per-step** human involvement only.
  The **end-of-milestone sign-off (§3) is always required**, at every milestone, at every
  level:
  - *L0 — calibration (M0–M1):* human approves **every** PR, to prove the agents are reliable.
  - *L1 — steady state (M2 onward):* Reviewer + CI gate each step automatically; the human
    surfaces at **every milestone boundary** and whenever an agent escalates.

---

## 6. Guardrails enforced by tooling (not prose)

- **`CODEOWNERS`** on the existing site files (root `*.html`, `*.js`, `*.css`,
  `image-slots.state.json`) → any change requires the founder's explicit approval.
- **CI changed-paths guard** → backend PRs that modify anything outside `api/`/`docs/`/
  `.github/` fail automatically. This is the machine-enforced "**don't touch the UI**".
- **Architectural lint** (`dependency-cruiser`) → forbid `api/` ↔ front-end imports;
  forbid importing a *real* adapter outside its sanctioned swap step.
- **Strict TypeScript + ESLint** → no `any`, no floating promises.
- **Deterministic tests** → inject clock/ids; no real time, network, or randomness in
  tests (flaky tests amplify drift).
- **Branch protection** → `main` requires green CI + one approving review.
- **ADRs** (`docs/adr/NNNN-*.md`) → a one-pager per non-trivial decision so choices
  aren't re-litigated months later.

> **Status:** `.github/CODEOWNERS` and `.github/workflows/ci.yml` (with the frozen-UI
> `protect-ui` guard + an ephemeral test Postgres) **already exist in the repo**. They
> only *block merges* once **branch protection** is enabled on `main` — do that at
> bootstrap (require the `ci` checks + code-owner review). The CI guard fails any PR that
> touches frozen front-end files unless it carries the `allow-ui-change` label (used only
> for the M7 wiring step).

---

## 7. Definition of Done (every PR — Reviewer + CI both check)

- [ ] Built only the step's "Build" list; nothing out of scope
- [ ] Tests written for the new behaviour (and they fail if it regresses)
- [ ] `npm run check` green (typecheck + lint + test)
- [ ] No files changed outside `api/` (and `docs/` when relevant) — UI untouched
- [ ] No real external service called in code or tests (except sanctioned swap steps)
- [ ] No interface, schema-contract, or dependency change (or it *is* this step's point)
- [ ] Human checkpoint passes (at milestone gates)

---

## 8. Escalate to the human — stop and ask when

- A step is ambiguous or under-specified.
- Completing it needs an out-of-scope change, an interface change, or a new dependency.
- A new external service or secret is required.
- A front-end / UI file would need to change (outside the sanctioned M7 wiring step).
- Two build attempts have failed.

Escalation is a feature, not a failure — it is how we trade a few tokens of "ask" for
avoiding many tokens of wrong-direction work.

---

## 9. Bootstrapping order (do this before turning the loop loose)

1. **Freeze** the spec + interfaces + schema decisions (largely done).
2. **Guardrails before autonomy** — `CODEOWNERS` + the CI `protect-ui` guard already
   exist; remaining: **enable branch protection** on `main` (require the `ci` checks +
   code-owner review), and add architectural lint once `api/` exists.
3. **Hand-build the exemplar (you + Claude, not an agent)** — Steps 0.1 and 1.1–1.5 to an
   exemplary standard (structure, test style, naming, error handling). This becomes the
   canonical pattern every later step copies — agents follow a concrete in-repo example
   far better than prose rules.
4. **Then** start the agent loop at the first un-built step, in calibration mode (L0).

Guardrails and the exemplar exist *before* autonomy. That ordering is itself anti-drift.

---

## 10. When to evolve

Stay at three roles for the single→multi-stop→shared backend arc. Introduce
surface/discipline specialists only when independent parallel tracks appear with few
shared files (e.g. ops dashboard UI, WhatsApp integration, reporting) — and even then,
keep the duty separation (build vs review) and the same gates.
