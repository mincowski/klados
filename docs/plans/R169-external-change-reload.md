# R169 — "Reload and Discard" looks like a dead button

<!-- status: open -->

**Open.** Register: `docs/TASKS.md`. Found by a user running R164–R167's owed manual pass. The
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
