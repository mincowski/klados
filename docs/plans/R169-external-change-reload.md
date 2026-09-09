# R169 — "Reload and Discard" looks like a dead button

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Results in §8. **The hypothesis below was confirmed and the
second-order defect was real: "Keep Mine" destroyed the edits it exists to protect.**
Found by a user running R164–R167’s owed manual pass. The
report is precise and worth quoting, because the second sentence is the diagnosis:

> Nothing happened in the UI, not sure if it reloaded in the background. When I clicked "keep mine",
> the notification disappeared but the file was actually reloaded. Maybe a temporal coincidence.
> But I would expect the loading bar, similar to opening a file, when hitting the reload button.

---

## 1. What is established from the code

Three facts, read at the line cited. None of them is the whole answer, but together they make the
reported sequence the expected one.

1. **The reload is fire-and-forget.** `notifications/commands.ts:56` —
   `run: (ctx) => void ctx.session.reloadAndDiscard()`. The `void` discards the promise, so nothing
   observes when it finishes and nothing observes it failing.

2. **The reload never leaves `phase: 'ready'`.** `documentSession.ts:2104`'s `reloadFromDisk`
   aborts the in-flight reparse/splice/transform, awaits the read and parse, and swaps the whole
   document in one `setState` at the end. **There is no intermediate phase**, so there is nothing
   for a progress indicator to hang off — the user's expectation of "the loading bar, similar to
   opening a file" is unmet by construction, not by oversight. `DocumentArea.tsx:203` renders
   exactly that indicator for `phase: 'parsing'`, which an open goes through and a reload does not.

3. **The notification is derived, so it clears only when the reload lands.**
   `Notifications.tsx:162`'s `runAction` calls the command and then `dismissNotification`, which
   its own comment notes is a **no-op for a derived notification** — the banner is a function of
   `document.externalChangeDetected`, and only `reloadFromDisk`'s final `setState` sets that false.

So between the click and the parse completing, **every visible signal says nothing happened**: no
phase change, no spinner, and the banner still sitting there — which reads as failure rather than
as work in progress.

## 2. The hypothesis, stated as one

The user's own "maybe a temporal coincidence" is very likely the mechanism rather than a
coincidence:

> Reload starts an async read + parse. Nothing changes on screen. The user waits, concludes the
> button is dead, and clicks **Keep Mine** — which flips `externalChangeDetected` **synchronously**,
> so the banner vanishes at that instant. The reload then lands and swaps the content, and the two
> unrelated events look like one.

**This is a hypothesis and R169's first job is to confirm or kill it**, not to build on it. It is
consistent with all three facts above and with the report, which is not the same as being true.

## 3. The second-order defect this exposes, if the hypothesis holds

**"Keep Mine" does not cancel an in-flight reload.** `keepMine()` (`documentSession.ts:2244`) only
clears the flag; `reloadAbort` is not touched. A user who clicks Reload, sees nothing, and clicks
Keep Mine to back out **still loses their edits** when the reload lands. The banner offers a choice
between two outcomes and the first one is not actually revocable.

Whether that is reachable in practice depends on §2 — but it is the same missing idea in both:
*nothing represents "a reload is happening right now."*

## 4. What R169 should do

In order, because each step's answer changes the next.

1. **Reproduce it.** `mainElectron.test.ts` now drives the real watcher end to end (R164's manual
   pass produced that test), which is the foothold: trigger a real external change, click the real
   button, and observe. A reproduction is what separates §2's hypothesis from a story.
2. **Give the reload a state.** Either a dedicated phase or a flag on the document; the constraint
   is that `DocumentArea.tsx` can render the same indicator an open already renders, so a reload
   stops being silent. Whether it should reuse `phase: 'parsing'` or carry its own is the round's
   own call — reusing it means the tab strip's label logic (`tabDisplay.ts:26`) starts saying
   "parsing" for a reload too, which may be right or may be a lie.
3. **Decide what Keep Mine means once a reload is in flight** (§3): cancel it, or refuse, or
   disable the button. Any of the three is defensible; silently losing the user's edits is not.
4. **Do not swallow the failure.** `void ctx.session.reloadAndDiscard()` should surface an error
   rather than discard it. A reload that fails on a file that has since been deleted currently
   leaves the banner up and no explanation, which is the same "looks dead" symptom from a genuinely
   different cause.

## 5. Non-functional expectation (`PLANNING.md` §3)

**Do not make the reload slower to make it visible.** Adding a phase transition must not add a
round trip or an artificial minimum display time — a small file reloads faster than a frame, and a
spinner that flashes for 16 ms is worse than none. The indicator should appear only if the reload
is still running after a threshold, the way a well-behaved progress affordance does.

`PLANNING.md` §1 **does** apply to step 2 — that is a visible change, and the plan does not settle
what it looks like. Render it against the real app and put the screenshot in front of the user
before deciding, per §1's own record: every visual decision rendered first survived contact; every
one reasoned about came back as a follow-up round.

## 6. Acceptance criteria

1. A test that reproduces the reported sequence, or a documented finding that it could not be
   reproduced and what actually happens instead.
2. Clicking Reload produces a visible change **within one frame** — the work may take longer, the
   acknowledgement may not.
3. The banner's disappearance coincides with the reload landing, not with an unrelated click.
4. The §3 case has a defined behaviour, with a test.
5. A failing reload surfaces an error rather than leaving the banner up silently.
6. No artificial delay added to a fast reload (§5).

## 7. Not in scope

The CRLF corruption (R168) and the tree's horizontal scrolling (R170), both found in the same
manual pass and both unrelated to this one.

---

## 8. Results

**Built.** The hypothesis in §2 was confirmed exactly, the second-order defect in §3 turned out to
be real and reachable, and the plan's own suggestion for the indicator (§4.2) turned out to be wrong
and was not implemented.

### 8a. §2's hypothesis was right, and the user's guess was the mechanism

Reproduced against the real session before anything was changed. The user wrote *"maybe a temporal
coincidence"*; it was:

```
banner up               : {"a":2}   external=true   dirty=true
immediately after click : {"a":2}   external=true   dirty=true   ← nothing changes
right after Keep Mine   : {"a":2}   external=false  dirty=true   ← banner vanishes here
after the reload lands  : {"a":99}  external=false  dirty=false  ← the edit is gone anyway
```

Every line of §1 held. Nothing moves at the click, the banner clears at the *Keep Mine* click rather
than at the reload, and the two unrelated events read as one.

**§3's defect is real: clicking Keep Mine destroyed the edits it exists to protect.** The banner
offered two outcomes and the first was not revocable. That is the more serious half of this round —
the missing indicator is a papercut; this one loses work.

### 8b. What landed

1. **`OpenDocument.reloadPending`** — the state that did not exist. Raised before the first `await`
   in `reloadFromDisk`, lowered on every exit including the early returns, and lowered *in the same
   `setState` that swaps the document* on success, so there is no frame in which the new content is
   showing while the acknowledgement is still up.

2. **`keepMine()` cancels an in-flight reload.** The mechanism was already there and simply never
   invoked: dropping `reloadAbort` makes `reloadFromDisk`'s own supersession checks bail before
   committing, and `abort()` additionally rejects the in-flight `parseFromUrl` through the signal.
   The fix is two lines; finding that it was needed took the reproduction.

3. **`reloadAndDiscard` resolves a `ReloadOutcome`** instead of `void`, and the command acts on it.
   **`cancelled` is a third outcome, not a failure** — a reload superseded by Keep Mine did what it
   was told, and a red banner there would punish someone for choosing to keep their own edits.

4. **The banner reports the reload** (§8c).

### 8c. The visual decision, rendered before it was settled (`PLANNING.md` §1)

Rendered against the app's own stylesheets in both themes and put in front of the user before the
round closed, per §1's rule.

**The chosen shape: the existing banner changes, rather than a new indicator appearing.** While the
reload runs it reads *"Reloading data.json from disk…"* and offers only **Keep Mine**.

**That choice is what makes §5 satisfiable with no timer at all.** §5 asks for no artificial delay
and no spinner flashing for 16 ms, and its own suggestion — show the indicator only after a
threshold — is a delay, just a defensible one. An element *already on screen* changing its text
cannot flash, so there is no threshold, no timer, and a 5 ms reload costs nothing. Acceptance 2
(visible within one frame) and acceptance 6 (no artificial delay) stop being in tension.

**Keep Mine stays, and is the cancel.** It reads correctly mid-reload — the user is still choosing
between disk and their own edits — and item 2 above made it genuinely revocable, so it is a real
escape hatch rather than a decoration. "Reload and Discard" is dropped while it is running, because
it is the thing already happening.

**A background auto-reload raises no banner**, asserted by its own test. A clean document
auto-reloads with no click behind it; there is no decision to present, and a notification appearing
unbidden for an operation nobody asked for is noise.

### 8d. §4.2's suggestion was wrong, and was not implemented

The plan said the constraint was that *"`DocumentArea.tsx` can render the same indicator an open
already renders"*, leaving open whether to reuse `phase: 'parsing'`.

**Reusing it is not an option, and the plan's own §4.2 already half-suspected why.** `DocumentArea`'s
`case 'parsing'` does not render an indicator *beside* the document — it returns the "Opening
{fileName}…" view **instead of** the panes. A reload entering that phase would unmount and remount
every pane, which is the caret and scroll destruction R41 exists to prevent, plus a full-view flash
on an operation that usually takes a few milliseconds, plus a tab label reading "parsing" and a
progress view saying "Opening" for a file that is already open.

Read at the line before building on it, per `PLANNING.md` §2. Hence a flag, not a phase — and the
reason is recorded on the field itself, where the next person to consider a phase will find it.

### 8e. Verified by breaking it

Both new behaviours were confirmed non-vacuous by mutation, not by their passing:

- Removing the two lines that make `keepMine` cancel: **two tests fail**, including the reproduction
  — `expected '{"a":99}' to be '{"a":2}'`, which is the user's lost edit, in an assertion.
- Restoring the command to `void ctx.session.reloadAndDiscard()`: the failing-reload test fails.

**One mutation went wrong in a way worth recording.** The first attempt at the `keepMine` mutation
matched an identical two-line sequence in the *document-close* path instead, silently removing a
real abort there — and the suite stayed green, which read as "the test is vacuous" when the truth was
"the mutation missed." Caught by checking that the mutation had landed where it was aimed rather than
trusting that it had. **A mutation you did not verify applied is not evidence of anything**, and a
green suite after one is the least trustworthy signal of the two possible readings.

### 8f. Acceptance, criterion by criterion

1. **Reproduced** (§8a) — and the reproduction is now a test.
2. **Visible within one frame** — `reloadPending` is raised before the first `await`, asserted
   synchronously after the call returns, with the phase asserted to still be `ready`.
3. **The banner clears with the reload landing** — asserted in the same test that checks the content
   changed, since both happen in one `setState`.
4. **§3 has a defined behaviour with a test** — Keep Mine cancels; the edit survives; the outcome is
   `cancelled`; a second test drains the microtask queue to catch a bail-out that still lets a later
   continuation write.
5. **A failing reload surfaces an error** — the session returns a message and the real registered
   command is driven against a stub session to prove it notifies.
6. **No artificial delay** — no timer exists anywhere in the change (§8c).

Suite **1874 → 1887**, lint at its 3-warning ratchet, typecheck clean.

### 8g. Review pass

Reviewed as a separate pass over `git diff`. One finding, fixed: the failing-reload path was
originally covered only at the session level, so the command's `notify` call — the thing acceptance
5 is actually about — was asserted by reading it. `Command.run` takes its session through an
`AppContext`, so it is drivable against a stub; three tests now cover fail, cancelled and success.

### 8h. Not fixed, and disclosed

**A clean document's background auto-reload still fails silently.** `handleExternalChange` calls
`reloadFromDisk` and now receives an outcome it ignores, because it is invoked from the watcher
subscription and has no caller to hand a failure to. Surfacing it would mean giving
`documentSession.ts` a notification dependency it deliberately does not have — `save` has the same
shape and the same gap. The user-visible consequence is narrow: a file changed on disk, the reload
of it failed, and the pane keeps showing content that is stale rather than saying so. Recorded
rather than fixed, because the fix is an architectural decision about where the session may report
to, not a line in this round.
