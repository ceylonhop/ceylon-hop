# Lead row contract

`leads.csv` is UTF-8 CSV with one header row, columns in this exact order. It is the import format
for the outreach Sheet (spec 2). `tools/outreach/validate-leads.mjs` enforces every ★ rule;
change this file and the validator together.

| Column | Rule |
|---|---|
| lead_id ★ | `<market>-<domain>` (domain = website host, lowercase, no `www.`), unique |
| market ★ | the brief's file name without `.md` |
| run_date ★ | YYYY-MM-DD |
| agency ★ | trading name |
| legal_entity | registered company name, if known |
| city | |
| country ★ | |
| website ★ | https URL; domain not already in `outreach/ledger.csv`, and not twice in the file |
| segment ★ | exactly one of the brief's segment names |
| destination_url ★ | https URL of the agency's own page selling our destination |
| format ★ | `private` / `mixed` / `group` |
| score ★ | integer 0–15 (see quality-bar.md) |
| score_breakdown | `fit<n> format<n> hook<n> reach<n> cred<n>` |
| wave ★ | `1` / `2` |
| to ★ | one email address |
| cc | email addresses separated by `;` |
| attn_name | required when contact_confidence is HIGH or MEDIUM |
| attn_title | |
| contact_confidence ★ | `HIGH` / `MEDIUM` / `LOW` / `none` |
| contact_sources | URLs separated by `;` |
| email_label ★ | label of the **to** address: `published` / `registry-filed` / `pattern-inferred` |
| follow_up | the agency's published WhatsApp or phone line, e.g. `WhatsApp +91 98765 43210` |
| hook ★ | one true, specific sentence about the agency |
| hook_source_url ★ | https URL the critic re-opened to confirm the hook |
| verified_at ★ | YYYY-MM-DD the critic confirmed it; 0–7 days before run_date |
| subject ★ | at most 90 characters |
| body ★ | at most 170 words before `[Name]`; must contain `no thanks` |
| status ★ | `draft`, or `needs-owner` if the draft critic's flags survived the fix pass |
| notes | anything the owner should know before approving |

## Ledger (`outreach/ledger.csv`)

`domain,market,first_seen,last_run,status`. One row per domain, ever. Status: `researched`
(made it into a leads.csv) or `rejected` (failed the bar). Spec 2 adds sent/replied/opted-out/won/lost.
