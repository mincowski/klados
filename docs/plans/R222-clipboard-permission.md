# R222 — copying to the clipboard, refused since R165

<!-- status: built -->

**Built** (§ 5). Found while testing R221 (`docs/plans/R221-electron-44.md` § 7) and scheduled by
the project lead for the same release, 1.2.1.

## 1. The defect

**Every copy button in the built application does nothing, and has done nothing since R165.** The
grid's CSV, TSV and Markdown buttons (`Grid.tsx`'s `runExport`) and Detail's "Copy path"
(`Detail.tsx`'s `copyPath`) call `navigator.clipboard.writeText`, which rejects with *"Write permission
denied"*. Measured on Electron 39 and 44 alike, so the upgrade did not cause it.

- **The cause is R165's blanket permission deny** (`main/index.ts`, inside `web-contents-created`).
  Both handlers refuse everything, and writing to the clipboard needs `clipboard-sanitized-write`.
  Allowing only that permission at runtime made the write succeed on both versions.
- **R164's plan rested on a false premise.** § 3 of `docs/plans/R164-release-security-hardening.md`
  said "the correct answer to every one of them is no", and listed clipboard *read* among the
  permissions to deny. Clipboard *write* was never considered, and the application had used it since
  M4.
- **Why nobody saw it:**
  - Both call sites swallow the rejection deliberately ("not worth an error banner for a copy
    button"), so a failed copy looks exactly like a button that did nothing.
  - The browser-project tests run copying in a plain Chromium, where no handler is installed, and
    pass either way.
  - R165's own test asks for a single permission (notifications) and checks that it is refused.

## 2. What Chromium asks, measured

In the built application on Electron 44, with handlers that log every call:
- **Write:** `writeText` makes one **check** for `clipboard-sanitized-write` and, when the check says
  no, one **request**. `navigator.permissions.query({ name: 'clipboard-write' })` makes a check of its
  own.
- **Arguments:** every call carries the page's full URL (`file:///…/out/renderer/index.html`; the
  check's `requestingOrigin` is only `file:///`) and `isMainFrame: true`.
- **Read:** `readText` asks for `clipboard-read`, which must stay refused.

## 3. The change

- **Grant exactly one permission, `clipboard-sanitized-write`, and only to the application's own
  page.** One predicate in `core/mainSecurity.ts`: the permission is on the list, the requesting URL
  passes `isAppUrl`, and the frame is the main frame. It uses the same rule R164 already applies to
  navigation and to IPC senders. Both handlers use it, so what `permissions.query` reports matches what
  the page can do. Every other permission stays refused, `clipboard-read` included.
- **Why this is safe enough to be the one exception:**
  - "Sanitized" names Chromium's write path for the standard formats, on which HTML is sanitized
    before it reaches the system clipboard. Klados writes plain text only.
  - Writing reveals nothing: it cannot read what the user copied elsewhere.
  - The worst a script in the renderer could do with it is overwrite the clipboard, and R164's
    navigation guard and CSP exist to keep any script but the application's out of the renderer.
  - Chromium still requires a focused document.
- **R165's test stays**, since notifications must still be refused. Built-app tests are added
  (`mainElectron.test.ts`):
  - A write from the page reaches the system clipboard.
  - A read is still refused.
  - `permissions.query` agrees with the write.
- **Not in this round: making a failed copy visible.** The silent `catch` in both call sites is why
  this went unnoticed for months. Whether a failed copy should say so is a UI decision, raised in
  § 5 for the project lead rather than decided here.

## 4. Verification

- Unit: the predicate for every permission name in Electron 44's type, for the app URL, for another
  `file://` page, for `http:`, and for a subframe.
- The built app: the three tests above.
- **Mutation, as R164 § 8c did:**
  - Revert the grant: the write test must fail.
  - Grant everything: the notifications test must fail.
- By hand, in the built app: every copy button, with the clipboard read back from main.

## 5. Results

**Built as planned.** Every copy button works in the built application. Only
`clipboard-sanitized-write` is granted, and only to the application's own page.

- **Unit** (`test/mainSecurity.test.ts`): the permission names come from the installed
  `electron.d.ts`, not from a copy, and of every one of them only `clipboard-sanitized-write` is
  granted. It is refused to:
  - another `file://` page, an `https:` page and an unparseable URL;
  - a subframe;
  - a request with no URL, or one made before the app URL is known.
- **Built app** (`test/mainElectron.test.ts`):
  - A write from the page reaches the system clipboard.
  - `readText` is refused with `NotAllowedError`.
  - `permissions.query` reports `clipboard-write` granted and `clipboard-read` denied.
  - R165's notification refusal still holds.
- **Mutation, as R164 § 8c did:**

  | Mutation | Failed | Passed |
  |---|---|---|
  | Both handlers answer `false` (R165 as it was) | the write test and the permission-API test | — |
  | Both handlers answer `true` | R165's notification test, the read test and the permission-API test | the write test |

  The code was restored and rebuilt after each.
- **By hand, in the built app:**
  - The grid's CSV button put the displayed rows on the system clipboard as CSV, header first.
  - Detail's "Copy path" put `/garage/cars/elements` there.
  - Both had failed in the same session on 39 and 44 before this round.
- The full suite passes: 189 files, 2,322 tests.

**For the project lead: a failed copy is still silent.** Both call sites swallow a rejection by design,
which is why R165's regression went unnoticed from 1.0.0 to 1.2.0. Chromium still refuses a write from
an unfocused document, for example. Whether that should show a notification is a UI decision this
round leaves open.

**Review:** read as a diff before the commit. One finding, fixed: the comment on the grant said Chromium
"strips active content from anything but plain text". More exactly, `clipboard-sanitized-write`
is the standard-formats write path, on which HTML is sanitized, and the comment now says that. No
defect in the code.
