# Writing specs

This file governs everything in `docs/specs/`.

A spec describes **what a thing is for, what shape it has, and what you can rely on it doing**. It
is not a record of how the thing was built, or of the conversation that led to it.

The test a spec has to pass: **someone reads it cold, months from now, and comes away knowing the
shape of the thing — and nothing in it has gone stale.**

## Include

- **Intent.** The problem being solved, and the constraint that shapes the answer. A reader should
  understand why the thing exists before they meet its details.
- **Shape.** Everything a user touches: config formats and their keys, the command surface, the
  inputs and outputs. Tables are good for key-by-key detail.
- **Expectations.** The guarantees. What is safe to rely on, stated plainly enough to be held to.
- **Failure.** What can go wrong, and what the user is told when it does.
- **Out of scope.** What the thing deliberately does not do. This is as load-bearing as the rest —
  it stops the next reader assuming a gap is an oversight.

## Exclude

- **Implementation.** Algorithms, data structures, library choices, internal module and function
  names, which underlying commands are invoked. If a refactor that changes nothing a user can see
  would force an edit to the spec, that sentence was implementation.
- **History.** Dates, "we changed X to Y", defects found and fixed, migration notes, task lists,
  progress. A spec has no past tense.
- **Process.** Reviews, plans, alternatives considered and rejected, who decided what and when.
- **Justification of choices against alternatives.** "We picked A over B because…" belongs in a
  commit message or an issue, where it stays attached to the moment it was true.

## Rationale — the one exception

Give a reason only where the behaviour is otherwise surprising, and keep it to a clause or two.
"There is deliberately no `--target`: the publish branch belongs to the mod, not the invocation"
earns its place, because a reader would otherwise file the absence as a bug. Explaining why the
config parser rejects unknown keys does not — the behaviour speaks for itself.

If the reason is about *how* rather than *what*, it does not belong here at all.

## Conventions

- **One file per user-facing unit**, named after the word the user actually types. The spec for
  `pa-mod-build publish` is `publish.md`, not `publish-command.md` or the name of any wrapper
  script that happens to invoke it.
- **No dates.** Not in filenames, not in headings, not in the body. A dated spec announces its own
  staleness and invites the reader to distrust it.
- **No version markers or changelog sections.** Git carries that.
- **Present tense, describing what is** — "a run that changes nothing produces no commit", never
  "we decided runs should not produce empty commits".
- **British English**, matching the rest of the repository.
- Wrap prose at roughly 100 characters.

## Before committing a spec

Read it back and ask:

1. Does anything in here describe **how** rather than **what**?
2. Would any sentence need editing after a change that no user could observe?
3. Does it mention a date, a decision, a review, or a defect?
4. Could someone who has never seen the code build a correct mental model from it alone?
5. Does it claim anything the thing does not actually do?

The last one matters most. A spec that over-promises is worse than no spec, because it will be
trusted. Where spec and behaviour disagree, one of them is a bug — decide which before shipping
either.
