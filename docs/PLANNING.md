# How a plan document earns its claims

**Read before writing a plan document**, alongside `docs/TASKS.md` (which holds the `R` register
and the board). This file is about the *content* of a plan, not its bookkeeping.

It exists because of an attribution check run after R118. The recent run of follow-up rounds —
R102, R104, R106, R108, R115/R117 — looked at first like the implementing agent being given too
much latitude. It was not. In almost every case the agent implemented what the plan said, and the
plan was wrong, incomplete, or asserting something untrue. Two are worth quoting, because they are
not close calls:

- **R108** (a Replace All that froze the app for an extrapolated ~196 seconds). R90's plan, §6:
  *"Apply back to front. Each splice shifts every later offset. Descending order keeps the match
  offsets valid without recomputing a single one."* That **is** the O(document × matches)
  algorithm. The plan optimised for offset correctness and never considered that each `applyPatch`
  copies the entire buffer.
- **R106** (a stray 1px line across the Detail pane). R91's plan, §5: *"Give `.detail` a
  `tabIndex={-1}` … the attribute is the only new thing."* It said so explicitly. A focusable
  element with no focus style gets the user agent's ring.

So the three rules below are aimed at the planner, not the implementer. Each one is here because
its absence cost a round.

---

## 1. Render a visual decision before writing it down as settled

**Every visual decision that was rendered first survived contact. Every one that was reasoned
about came back as a follow-up round.**

| Rendered before deciding | Outcome |
|---|---|
| R104's stacked start pane | rendering caught that `flex-basis` is a *height* in a column container — the first attempt put the two sections at opposite ends of a tall box |
| R118's scrim removal | confirmed both themes still read as elevated, and measured that light's panel is the *same colour* as the app behind it |
| R117's `::selection` | computed values were right in an earlier attempt too; only the screenshot proved it painted |

| Reasoned about only | Outcome |
|---|---|
| R105's whole-row button | reversed after one look — a row that looks like a link but responds to clicks in its own whitespace reads as broken |
| R106 §2's inset focus ring | reversed after one look — a ring inside the pane reads as a sub-region, not the pane |

Both reversals had *sound written arguments*. That is the point: the argument being good is not
evidence that the result looks right, and the two are cheap to tell apart. Render it, put the image
in front of the person who has to live with it, and let them redirect in one message instead of one
round.

The browser test project is the harness — mount the real DOM against the app's own stylesheets and
screenshot. Minutes, not hours.

## 2. Verify a mechanism before asserting it as fact

If a plan says *"X already does Y"*, check that X does Y. Not that its documentation says so, not
that its source contains a rule that looks like it.

R115 asserted that CodeMirror renders the text selection and ships a focused/unfocused pair *"so
an unfocused editor's selection can be dimmed"*. True of the base theme's CSS; false of this
editor, where `drawSelection()` is not among the extensions, so the class never reaches the DOM.
One probe — mount a real editor, make a selection, count the nodes — would have caught it before
the plan was written. It instead cost a wrong implementation, a wrong caveat, and R117.

The failure is specific and worth naming: **a rule existing in a library's stylesheet is not
evidence that the rule applies.** Neither is a computed CSS value evidence that anything is
painted (§1's R117 row).

## 3. State the non-functional expectation wherever the obvious implementation is wrong

A plan that describes only *what* leaves *how* to whoever implements it, which is correct — except
where the natural reading of "what" produces something quadratic, recursive over user input, or
allocating per item in a loop. There, the expectation is part of the specification.

R108 needed one clause: **"N matches, one allocation — not one splice per match."** Instead the
plan specified the splice order and said nothing about cost, and the result was linear in
`document × matches`.

Same class, less dramatic: R104 came back because R96/R97 specified "a list of recent files" and
left spacing, truncation priority and behaviour at narrow widths unstated. Where you know what the
answer has to be, say it; the round it saves is your own.

---

## What this does not ask for

Not longer plans. R90's §6 was detailed and confident and still specified the quadratic algorithm;
R91's §5 was explicit that no styling was needed. **Length was never the problem** — these three
rules are each about doing one cheap check before writing a sentence down as settled.

And not more caution about the `R` count. R108 found a three-minute freeze in a routine operation,
R112 found F6 completely dead, R117 found Raw's selection unthemed in both themes. Those numbers
are the review-and-report discipline working. A process producing fewer follow-up rounds would
most likely mean those were still shipped and unnoticed.
