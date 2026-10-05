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

There are **two** homes for a label, and they must agree:

| Home | Who uses it | Shape |
| --- | --- | --- |
| `.scratch/<feature>/issues/NN-*.md` | agent 工作流（`/wayfinder`、MATT 工单流） | 文件顶部一行 `Status: needs-triage` |
| GitHub repo | 对外 issue / PR | 真实 label 对象，由 `.github/ISSUE_TEMPLATE/*.yml` 的 `labels:` 字段自动带上 |

Both are real. The GitHub labels are created objects — `gh label list` will show them.
An issue template that names a label which does not exist **silently drops it**: the issue
gets filed with no label and nothing errors, so the gap only shows up later as "why is
nothing triaged?". After changing a label string here, apply it to both homes.
