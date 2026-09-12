# R198 — the release publishes update metadata for an updater that does not exist

<!-- status: built -->

**Built.** Found by reading the first real release's asset list, immediately before publishing it.

## 1. What shipped

The `v1.0.0` draft carried **ten assets, five of which serve `electron-updater`**:

```
latest.yml                            update feed, Windows
latest-mac.yml                        update feed, macOS
latest-linux.yml                      update feed, Linux
klados-1.0.0-mac.dmg.blockmap         differential download index
klados-1.0.0-mac-intel.dmg.blockmap   differential download index
```

**This application has no updater.** `electron-updater` is not a dependency, and nothing in `src/`
calls `autoUpdater` — both checked, not assumed. So half the assets on the release are plumbing
nothing will ever fetch, and `SHA256SUMS.txt` dutifully hashed all five.

## 2. Why this is a correction rather than a new decision

**The reasoning already exists in the file, twice, and stopped one step short both times.**

`mac.target` dropped the zips:

> the zip exists almost entirely for `electron-updater`, which cannot update from a dmg. This
> application has no auto-updater … so the zips were two assets serving nobody.

`nsis.differentialPackage` turned the blockmap off for Windows:

> A blockmap is a content-chunk index that lets `electron-updater` download only the changed blocks
> between versions — it describes an update mechanism this application does not have.

Both are right, and neither was carried across. The dmg target was never revisited, so the first
release built two blockmaps under a rule that had already rejected the Windows one; and the
`latest*.yml` feeds were never considered at all, because nothing prompts you to think about a
publish-time artifact while configuring a target.

**Found by looking at the output, not by any check** — which is `FINDINGS.md`'s recurring line about
this project in yet another place, and the reason the previous round's rehearsal argument (D-095)
has value even when the tag is still free to move.

## 3. R198

```yaml
dmg:
  writeUpdateInfo: false

publish:
  provider: github
  publishAutoUpdate: false
```

**Both gates read from source rather than guessed at**, since an option that silently does nothing
would leave the same assets on the next draft:

- `dmg-builder/out/dmg.js` — `writeUpdateInfo === false ? null : createBlockmap(...)`.
- `app-builder-lib/out/publish/updateInfoBuilder.js` — `if (publishConfig.publishAutoUpdate ===
  false)` skips writing the channel file.

`provider: github` **restates the inference rather than changing it**: a `publish` block is needed
to carry the flag, and owner and repository are still derived exactly as before. **Publishing is
not disabled** — the installers, dmgs, AppImage and `.deb` upload as they did.

## 4. Rejected

**Deleting the assets from the release afterwards.** It works once and is forgotten next time; the
build should not produce them.

**`--publish never` plus manual upload.** Trades one unwanted artifact class for a manual release
step and loses the draft that R141 relies on to accumulate four platforms' output.

**Removing `nsis.differentialPackage: false` as now redundant.** It is not — `publishAutoUpdate`
governs the channel files, `writeUpdateInfo` the dmg blockmap, and `differentialPackage` the NSIS
one. Three separate gates, and collapsing them is how one quietly comes back.

## 5. Acceptance

1. A Windows build produces **no `latest.yml`** — verified locally, since this is the one target
   this machine can build.
2. The installer is byte-size unchanged: the round removes sidecars, not content.
3. The re-tagged release draft carries **six** assets: four installers, the `.deb`, and
   `SHA256SUMS.txt` — no `latest*.yml`, no `.blockmap`.
4. `npm test`, `npm run typecheck`, `npm run lint` clean.

**Acceptance 3 cannot be checked before the tag moves**, and the plan says so rather than implying
otherwise: the dmg blockmap needs a macOS build, and the `latest-mac.yml` / `latest-linux.yml`
feeds only appear on a publishing run. The Windows half is proven locally; the rest is confirmed on
the draft.

## 6. Version

**No bump.** Packaging configuration; the application is unchanged.

---

## 7. Results

**Landed as planned.** Two configuration keys; no application code changed.

| | |
|---|---|
| `dmg.writeUpdateInfo: false` | stops the two dmg `.blockmap` files |
| `publish.publishAutoUpdate: false` | stops `latest.yml`, `latest-mac.yml`, `latest-linux.yml` |

### Acceptance

| | |
|---|---|
| 1 — no `latest.yml` from a Windows build | **verified locally**: `dist/` holds only the installer, where it previously held `latest.yml` beside it |
| 2 — installer byte-size unchanged | **81.3 MB, identical** |
| 3 — the draft carries six assets | **confirmed on the re-tagged draft** (below) |
| 4 — suite, typecheck, lint | clean |

### Review

Nothing found. The round is two keys, and the risk it carries is not that they are wrong but that
they are **inert** — an option that silently does nothing would leave the same five assets on the
next draft and look identical until someone read the list again. That is why both gates were read
out of `node_modules` before being written down, and why acceptance 1 is an observed absence in
`dist/` rather than a claim about the config.

The plan's § 4 rejection of *"removing `nsis.differentialPackage: false` as now redundant"* is worth
keeping in view: three separate gates govern the channel files, the dmg blockmap and the NSIS
blockmap. Nothing in the code ties them together, so tidying one away later would quietly restore
one of the artifacts this round removed.

### Owed

**Nothing.**
