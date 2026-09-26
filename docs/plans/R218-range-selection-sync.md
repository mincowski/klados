# R218 — a text selection in Raw resolves to the node that contains it

<!-- status: built -->

**Built.** Raised by the project lead as a question, answered by reading the code, and decided on
the answer: dragging a text selection in Raw moved the node selection to wherever the pointer was,
even mid-drag. Now nothing resolves while the mouse button is held, and a range resolves to the
smallest node containing all of it. Decision: D-110. Planned for a bug-fix release (1.1.1), with
R215–R217.

## 1. The report

> *When I have a node selected that has multiple child nodes, and then I drag a text selection in
> the raw view, the node selection changes. I think it is updated to where the cursor currently is
> while I drag the selection. Is that intentional? […] When I select with the keyboard, the same
> happens […]. There it feels more natural though.*

## 2. What the code did, and why it was not a decision

`rawCaretSync.ts` scheduled a 200 ms resolution on every selection change and resolved the
selection's **head** — the end that moves — with `nodeContainingOffset`. So:

- **mid-drag**, any pause of 200 ms moved the node selection, and with it the band, the Tree and
  the Detail pane, under a pointer that had not finished;
- **on release**, the node selection landed on the node at the pointer, which says nothing about the
  text selected;
- **Shift+arrow** took the same path; it felt natural only because the head moves in small steps.

**Not a decision.** M1-PLAN.md D14 and `CONCEPT.md` §4.4 say *moving the Raw caret* resolves offset
→ node → selection. Nothing in the plans, `DECISIONS.md` or the code considered a range; the
module's own comment named a drag only as a reason to debounce.

## 3. Options put to the project lead

| Option | Mouse drag | Shift+arrow |
|---|---|---|
| **A — no update during a drag; a range resolves to the smallest node containing it** — chosen | resolves once, on release; within the selected node across its children, the node stays | grows the node selection outward as the range crosses node boundaries |
| B — a range never changes the node selection | nothing changes | nothing changes either — the keyboard behaviour the report liked is lost |

The project lead: *"For mouse only, I think having no update of the node selection would make
sense but I don't like the implication for the keyboard control"* — and chose A for keeping mouse
and keyboard consistent. Under A the report's own case does not change the node: a drag across
several children of the selected node is contained by that node.

## 4. What landed

- **A range resolves with `nodeContainingRange`** (`nodeSpanLookup.ts`), the innermost node fully
  containing `[start, end)` — already written for F4's subtree splice, so not written twice. A caret
  resolves as before.
- **Layout whitespace is trimmed from both ends first** — space, tab, CR, LF, not Unicode's wider
  set. Found while designing rather than reported: Shift+Down over exactly one line selects the
  line's indentation and line break, which belong to the parent, so without trimming one `<title>`
  line resolved to its `<book>`. A selection of nothing but whitespace resolves as a caret. The trim
  reads one character at a time from each end, never slicing the range, since a selection can cover
  the whole window.
- **Nothing resolves while the primary button is held on the content.** A capture-phase `mousedown`
  on `.cm-content` marks the hold, before CodeMirror's own handler dispatches the press's selection;
  `mouseup` on the document (where CodeMirror listens for its own drag's end), `dragend` and a window
  blur release it, and a release resolves once if the selection changed during the hold.
- **A missed release cannot switch caret sync off.** CodeMirror tags every selection a drag makes
  `select.pointer`; any other selection change while "held" drops the hold and resolves normally.
  Without this, a lost `mouseup` would have silently disabled keyboard resolution until the next
  click — found in review, not in use.
- The timer and flags moved from the extension into the view plugin, one set per editor view.

## 5. Tests and verification

`test/rawCaretSync.test.tsx`, on a nine-line XML shelf: a range across two children, inside one
element, backwards, over exactly one whole line, across two siblings, and whitespace only; a drag
held past the debounce that must not resolve and then resolves on release; a click; a missed release
followed by a keyboard move; and `trimLayoutWhitespace` itself, including a no-break space at an
edge, which stays.

**Every rule was removed in turn and turned a test red**: ignoring the hold, dropping the trim,
dropping the range rule, dropping the self-heal.

In the built application, with real mouse and keyboard input through Playwright, `book` selected
from the Tree:

| Action | Node selection |
|---|---|
| press inside `<title>`, drag to `<author>`, **hold 600 ms** | `book` — unchanged |
| continue to `<year>`, release | `book` |
| drag within `<title>`'s text | `title` |
| click in `<title>` | `title` |
| then Shift+Down | `book` |

## 6. Review

Read from `git diff` before committing.

- **Found and fixed: two vacuous tests.** The document opens with `<shelf>` selected, so a test
  expecting `shelf` passed whether or not anything resolved, and the whitespace-only test's
  expectation was also wrong (its head sat at `<book>`'s start, inside `<book>`). Both now start
  from, or expect, a node other than the opening selection.
- **Found and fixed: a click that was a triple-click.** The synthetic `mousedown` had `detail: 0`,
  which CodeMirror reads as a click count, so the "click" test was selecting a whole line — shown up
  when removing the trim broke a test about clicking. `detail: 1` makes it a click.
- **Found and fixed: the stuck-hold case** in § 4.
- `view.win` is not in CodeMirror's public types; the document's `defaultView` is used instead.
