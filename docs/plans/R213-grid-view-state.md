# R213 — keep a table's sort, columns and filters when switching group tabs

<!-- status: open -->

**Open.** Raised by the project lead while accepting R211's tabs: switching to another group and
back resets the table, and *"we'll have to keep the sorting etc"*. R211 recorded it as a known
limitation (D-104) rather than an oversight, because keeping every group's grid mounted to preserve
the state would reintroduce the cost the tabs removed. This plan is the other way to keep it.

## 1. What is lost today, from the code

`Grid.tsx` holds all of its view state in component state, and `Detail.tsx` renders it with
`key={selectedTable.nameId}`, so a tab switch **unmounts the grid and discards everything below**.
Read from `Grid.tsx`, not recalled:

| State | Shape | Keyed by | Worth keeping? |
|---|---|---|---|
| `sort` | `{ nameId, direction }` | column name id | **yes** — the case raised |
| `extraColumns` | `Set<nameId>` | column name id | **yes** — the column picker's selection |
| `pinned` | `Set<nameId>` | column name id | **yes** |
| `widthOverrides` | `Map<nameId, px>` | column name id | **yes** — a resized column snapping back reads as a bug |
| `filters` / `filterInputs` | `{ quick, perColumn: Map<nameId, string> }` | column name id | **decision, § 3** |
| `filterRowOpen` | `boolean` | — | yes, with filters |
| `active` | `{ row, col }` | display position | decision, § 3 |
| scroll offset | on `parentRef` | display position | decision, § 3 |
| `pickerOpen`, `hiddenMatchesOpen`, `pendingExport` | transient | — | **no** — open menus and a pending confirmation must not reappear |

**Every piece worth keeping is O(columns), keyed by column name id. None of it is O(rows).** That is
what makes this cheap to store and is the property § 5 protects.

## 2. Tabs are the visible case, not the only one

The same state is also lost when the user selects another node and comes back: `Detail` renders the
selected node, so leaving it unmounts its grid. That was always true and rarely noticed, because it
took navigating away and back. R211 made the same loss one click away, on a control whose whole
purpose is going back and forth — which is why it surfaced now.

**The round must say which of the two it covers.** Tab switching is the requirement. Node switching
falls out of the same mechanism almost for free, depending on the keying in § 3 — but it also
changes behaviour that has been stable since M2, so it is a decision, not a side effect.

## 3. The decision this round has to make: what the state is keyed by

R211 already made one choice of this kind: **the selected tab is remembered by group name per
document** (`GridGroupPicker.tsx`), so stepping between sibling `<shelf>` nodes keeps `magazine`
open. The candidates here:

- **(a) Per group name, per document.** Sorting `book` by `year` on one shelf means every `book`
  table in the document sorts by `year`. Consistent with R211's tab memory, and it covers node
  switching too. **Right for the shape of a table** — sort, extra columns, pins, widths — because
  those describe how the user wants to read *that kind of record*.
- **(b) Per node and group.** Exactly "this table as I left it". **Right for filters**, because a
  filter describes content: carried to a sibling shelf, a quick filter of `Buddenbrooks` shows an
  empty table with nothing on screen explaining why — the same unexplained-emptiness this project
  has now fixed twice (the coverage cliff, the CSV rows).

**Provisional recommendation: split it.** Shape state keyed as (a); filters, the filter row, the
active cell and the scroll offset keyed as (b). This needs the project lead's call before building,
because it is the difference between "the app remembers how I like `book` tables" and "the app
remembers this one table".

**A mechanism the round must verify before relying on it** (`PLANNING.md` §2): whether column name
ids survive an edit. R211's tab memory is keyed by `NodeStore` and is lost when a reparse replaces
the store — acceptable for one remembered tab, less so for a carefully sorted, pinned, resized
table. Whether a splice keeps the interner (and so the ids) and whether a full reparse does not is
to be **checked against `subtreeSplice.ts` and the reparse path**, not assumed. If ids do not
survive, key durable state by column *name text* and resolve it to ids on restore. Node refs are
the less stable half of (b): they shift under edits, so (b) may need to be "until the document is
edited" and say so.

## 4. Mechanism

Lift the persistent half of `Grid`'s state out of the component into a small store — the same
module-level `WeakMap<NodeStore, …>` shape as R211's `rememberedGroup`, so it is scoped to one open
document and dropped with it. `Grid` is initialised from it on mount and writes back on change. **The
grid is still unmounted on a tab switch**; only its view state survives.

On restore:

- **Columns that no longer exist are dropped silently.** An edit can remove the column a sort or pin
  refers to; restoring must not throw, must not sort by nothing, and must not leave a ghost pin.
- **Filters commit immediately**, not through the 200 ms keystroke debounce (`FILTER_DEBOUNCE_MS`) —
  a restored filter is not typing.
- **Transient state never restores** (§ 1's last row).

## 5. Non-functional expectations (`PLANNING.md` §3)

- **Store view state, never results.** Do not cache `displayIndices` or a sorted order per group: an
  `Int32Array` of display indices is 4 bytes per row, **8 MB per group for a two-million-row group**,
  and one per group per document is exactly the O(rows) retention invariant 2's spirit rules out.
  Restoring re-derives the order from the stored `{ nameId, direction }` and filters.
- **So restoring costs a filter pass and a sort** — O(members) and O(n log n) over that group — on
  every switch back. **The round measures that switch latency** on `spike/fixtures/cars-10mb.xml`
  and the 200 MB fixture and records it. If it is too slow, that measurement is where caching is
  reconsidered, with its memory stated; not before.
- **Nothing per keystroke becomes more expensive.** Writing state back on change must not add work
  to the filter-typing path the debounce exists to protect.

## 6. Acceptance

1. Sort a group, switch to another tab and back: **same column, same direction**.
2. The column picker's extra columns, pinned columns and resized widths survive the same round trip.
3. **Groups do not share state**: sorting `book` leaves `magazine` unsorted.
4. Filters behave as § 3 decides, asserted both ways — kept where they should be, *not* carried where
   they should not.
5. A restored sort or pin naming a column that no longer exists is dropped without an error, and
   the table renders.
6. Open menus and a pending export confirmation do not reappear after a switch.
7. The stored state holds nothing sized by row count — asserted on its shape.
8. The palette's `Copy Grid as CSV/TSV/Markdown` export the **restored** order and filters.
9. Switch latency on the 10 MB and 200 MB fixtures is measured and recorded (§ 5).
10. Whether column name ids survive a splice and a full reparse is verified and recorded (§ 3), and
    the keying follows from what was found.
11. `npm test`, `npm run typecheck`, `npm run lint` clean.

## 7. Rejected

**Keeping every group's grid mounted and hidden.** Preserves everything with no new code, and is
the cost D-104 rejected the stack for: one live virtualizer and one column collection per group,
whatever the group count.

**Caching sorted or filtered index arrays.** O(rows) per group per document (§ 5).

**Persisting view state across application restarts.** Session restore persists paths only (R29,
by design); widening it is a separate question with its own privacy and staleness answers.

## 8. Version

**Ask on landing.** Candidate: patch — behaviour the user already expects, no new capability.
