# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Where the label physically lives

The tracker is **GitHub Issues** (see `issue-tracker.md`). All five labels in the table above are
real label objects already provisioned on `wangpanbin/bookmark-organizer` — `gh label list` shows
them, so `triage` applies them with `gh issue edit <n> --add-label "<name>"` and never has to
create one. Do not hand-edit the right-hand column to invent new strings: a name that doesn't
exist on the remote makes `--add-label` fail.

Two paths apply a label automatically, and one of them fails silently:

| Path | Applies labels? | Notes |
| --- | --- | --- |
| `.github/ISSUE_TEMPLATE/*.yml` via the **web UI** | yes — the `labels: ["needs-triage"]` field | only for humans filing in the browser |
| `gh issue create --title/--body` | **no** — templates are bypassed entirely | pass `--label "..."` yourself |

An issue template that names a label which does not exist **silently drops it**: the issue gets
filed with no label and nothing errors, so the gap only shows up later as "why is nothing
triaged?". After changing a label string here, create it on the remote too.

## Legacy: `.scratch/`

Tickets used to live as local markdown with a `Status:` line per file. That tree is a
**pre-migration snapshot**, not a live tracker — do not read its `Status:` lines as current state.

