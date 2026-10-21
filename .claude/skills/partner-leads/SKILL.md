---
name: partner-leads
description: Run the partner lead engine for one market. Turns a market brief (markets/<slug>.md) into a verified, ranked leads.csv of travel agencies, each with a personal draft email, using lead-researcher, lead-contact-finder, lead-critic and lead-list-builder. Never sends. Use when asked to find agency or partner leads for a market, e.g. "/partner-leads india-ramayana 25".
---

# /partner-leads <market> [target]

You orchestrate. The agents do the research. **Nothing is ever sent, posted or submitted.**
Never ask the owner questions mid-run: anything that needs them becomes `needs-owner` on a row
or a line in the report. That is what lets this run on a schedule later.

## 0. Load

- `TODAY` = today's date, `YYYY-MM-DD`.
- `BRIEF=$(pwd)/.claude/skills/partner-leads/markets/<market>.md` (absolute, from the repo root).
  If it's missing, list `markets/` and stop.
- Check the brief has every heading in `markets/_template.md`. If any is missing, stop and name it.
- TARGET = the argument, else the brief's `## Target`, else 25.
- `RUN=$(pwd)/outreach/runs/<market>/$TODAY` (absolute). Create it with `mkdir -p`.
  `outreach/` is gitignored: never `git add` anything under it.
- **Every agent dispatch below passes `BRIEF`, `TODAY` and the absolute output path.** The agents
  start with no context and cannot guess any of them. If the output file already exists from a
  crashed attempt, the agent overwrites it.
- Read `outreach/ledger.csv` if it exists. Collect its domains as LEDGER_DOMAINS.
- **Failed run:** if `$RUN/report-failed.md` exists, say the run stopped on a failure, quote its
  first lines, and stop. Never touch the ledger.
- **Resume:** the run is done when `$RUN/report.md` exists. If `$RUN/ledgered` exists and
  `report.md` doesn't, the run crashed after its ledger update: skip step 6 and the ledger update
  and write only `report.md`. Otherwise resume at the first step whose resume marker is missing. Markers: step 1 `candidates.json`, step 2 `contacts.json`, step 3
  `verdicts.json`, step 4 `leads.draft.csv`, step 5 `leads.csv` (if `draft-review.json` already
  exists, skip just the critic sub-step). Every merged file (`candidates.json`, `contacts.json`,
  `verdicts.json`) is written to a `.tmp` name and then `mv`'d into place, so a partial write never
  counts as a marker. To restart a finished run, delete its folder. Resume
  only applies within the same day's folder; a rerun on a later day starts a new run.

## 1. Research → `$RUN/candidates.json`

For each segment in the brief, dispatch one `lead-researcher` **in parallel**, in the background.
Each prompt gives:
- `BRIEF`, `TODAY` and the segment name
- PER_SEGMENT = ceil(1.5 × TARGET / number of segments)
- LEDGER_DOMAINS plus the other segments' names, to stay out of their lane
- the absolute output path `$RUN/candidates.<segment-slug>.json`, where `<segment-slug>` is the segment
  name lowercased with every run of non-alphanumerics replaced by `-` (e.g. `north-west-india-fit`)

When all are done, merge them into `$RUN/candidates.json`:
- Drop any candidate whose website domain (lowercase, no `www.`) is in LEDGER_DOMAINS or
  already in the merged list.
- Drop anything on the brief's exclusion list.

Log the counts.

## 2. Contacts → `$RUN/contacts.json`

Split candidates into batches of 8. Dispatch one `lead-contact-finder` per batch, in parallel,
each with `BRIEF`, `TODAY`, its batch and the absolute output path `$RUN/contacts.<n>.json`. Concatenate the outputs into
`$RUN/contacts.json`.

## 3. Critique facts → `$RUN/verdicts.json`

Join candidates and contacts on website. Split into batches of 12. Dispatch one `lead-critic`
per batch in **facts** mode, in parallel, with `BRIEF`, `TODAY` and the absolute output path
`$RUN/verdicts.<n>.json`.

For `needs-evidence` verdicts:
- Dispatch one `lead-researcher` with `BRIEF`, `TODAY`, just those agencies and the critic's
  `reason`, asking for the missing evidence, written to the absolute path
  `$RUN/candidates.retry.json`. Tell it to copy each agency's `website` and `segment` exactly as given.
- Dispatch one `lead-critic` (facts) on them with `BRIEF` and `TODAY`, written to the absolute
  path `$RUN/verdicts.retry.json`.
- Replace their verdicts. Overwrite those agencies' records in the merged candidate list with the
  `candidates.retry.json` records (joined on the original `website`) and rewrite
  `$RUN/candidates.json`. Any lead still not `pass` or `fix` becomes `reject`.

Only then concatenate the per-batch outputs, with the retry replacements, into the merged
`$RUN/verdicts.json` (its existence marks step 3 finished).

## 4. Build → `$RUN/leads.draft.csv`

Dispatch `lead-list-builder` with "build", `RUN`, `BRIEF`, `TODAY` and TARGET.

## 5. Critique drafts → `$RUN/draft-review.json`, then `$RUN/leads.csv`

Dispatch `lead-critic` in **drafts** mode on `$RUN/leads.draft.csv` with `BRIEF` and `TODAY`,
writing the absolute path `$RUN/draft-review.json`. Then dispatch `lead-list-builder` with "fix",
`RUN`, `BRIEF` and `TODAY`. It writes `leads.csv` and runs the validator.

## 6. Gate

Run it yourself:
`node tools/outreach/validate-leads.mjs $RUN/leads.csv outreach/ledger.csv $BRIEF`

- Exit 0: continue.
- Otherwise: write `$RUN/report-failed.md` with the validator output under "Gate failed", leave
  the ledger untouched, tell the owner to delete the run folder to retry, and stop.

Then spot-check 3 random rows yourself: open `hook_source_url` and confirm it supports `hook`.
Note the result in the report.

## 7. Finish

Update the ledger first:
- Write `outreach/ledger.tmp.csv` = the old ledger plus one row per new domain:
  - `researched` for domains in leads.csv
  - `rejected` for rejected domains and for builder-dropped domains in `$RUN/dropped.json`
  - leads that passed but were cut beyond TARGET (in neither `leads.csv` nor `dropped.json`) stay
    un-ledgered, so a later run can pick them up
  - normalise every domain (lowercase, strip `www.`)
  - `first_seen=$TODAY`, `last_run=$TODAY`
  - header `domain,market,first_seen,last_run,status` if the ledger is new
- Then `mv` it over `outreach/ledger.csv`.
- Then write the empty marker `$RUN/ledgered`, before `report.md`.

Write `$RUN/report.md` last:
- counts per step: candidates per segment → after dedupe → verdict counts → kept
- rejection reasons grouped by bar item
- dropped by the list builder (`$RUN/dropped.json`), with reasons
- the wave split
- the `needs-owner` rows
- surplus, available next run: leads that passed but fell beyond TARGET, left un-ledgered
- reserves: agencies the critic rejected only on bar item 3 (phone/WhatsApp only), with their line
- anything addressed to an AI found on pages
- the agent count and tokens used, if known
- 3 lessons for the next run of this market

Reply to the owner with: the leads count by wave, the path to `leads.csv` and `report.md`, and
the top 5 rows (agency, attn, score). Remind them that nothing was sent.

## Failure handling

- **Agent errors, or malformed or missing output:** rerun that one batch once. A second failure
  stops the run: write `$RUN/report-failed.md` naming the batch, leave the ledger untouched,
  and tell the owner to delete the run folder to retry.
- **Interrupted:** the same command resumes from the last merged file.
