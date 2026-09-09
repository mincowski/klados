# R182 — CI depends on a vendor apt repository it does not use

<!-- status: open -->

**Open.** Register: `docs/TASKS.md`. Every Linux CI run refreshes Google's Chrome apt repository,
which this project never uses. When that repository is internally inconsistent the job exits before
running a single test, and the pull request reads as failing.

Found by CI itself, on a documentation-only pull request that could not have affected apt.

---

## 1. What happened

`ubuntu-latest` failed twice, eight minutes apart, on PR #18 — two markdown files. `macos-latest`
and `windows-latest` passed the full suite both times.

```
E: Failed to fetch https://dl.google.com/linux/chrome-stable/deb/dists/stable/main/binary-amd64/Packages.gz
   Hashes of expected file:  SHA256:233e56de019b57db89238fa7bcc3647718dbbea3a40c2dc1c633a8c8952aa9e9
   Hashes of received file:  SHA256:bc1428ab27c6d76ee9bb76de07f1ded0ddb4aaabd958fc72855634ef5894a4b3
   Last modification reported: Wed, 09 Sep 2026 09:41:12 +0000
   Release file created at:    Wed, 09 Sep 2026 17:16:59 +0000
E: Some index files failed to download.
Failed to install browsers
Error: Installation process exited with code: 100
```

Google's mirror was serving a `Release` file created at 17:16 alongside a `Packages.gz` last
modified at 09:41. The hashes disagreed, apt refused the index, and `apt-get update` returned 100.

**The step that died is `npx playwright install --with-deps chromium`.** `--with-deps` runs
`apt-get install`, and `apt-get update` refreshes **every** configured source, not the ones the
install needs.

## 2. Why the repository is there at all, and why nothing needs it

The GitHub `ubuntu-latest` image preinstalls Google Chrome and its apt source. This project does not
use it: the browser project drives **Playwright's own Chromium**, downloaded by `playwright install`
from Playwright's CDN, and `_electron` launches the packaged app's bundled Electron. Nothing in the
repository references a system Chrome.

So the pipeline takes a hard dependency on a third-party mirror for a package it never installs, and
inherits that vendor's outages as its own red builds.

## 3. Both Linux steps are exposed, not one

The failure surfaced in the Playwright step, but it is not the only one:

```yaml
- name: Install xvfb
  if: runner.os == 'Linux'
  run: sudo apt-get update && sudo apt-get install -y xvfb
```

That is a second `apt-get update` over the same sources. Had the first step been ordered after it,
this is where the failure would have appeared. A fix that only guards the Playwright step would
leave the same defect one reordering away — which is the R164 argument again: the guard's value is
covering what nobody enumerated.

## 4. The fix

One Linux-only step, placed before both apt consumers, removing the sources this project does not
use:

```yaml
- name: Remove unused vendor apt sources
  if: runner.os == 'Linux'
  run: |
    grep -rl 'dl\.google\.com' /etc/apt/sources.list.d/ 2>/dev/null | sudo xargs -r rm -f
```

**Matched on content, not filename.** Removing `google-chrome.list` by name would work today and
stop working silently the day a runner image renames it — the file would come back, the dependency
with it, and nothing would say so. Grepping for the host removes whatever declares it.

**`xargs -r`** so an image that has already dropped the repository is a no-op rather than a failure.

The step prints the remaining sources, so a future failure of this kind can be diagnosed from the
log without reproducing it.

### 4a. Why not the alternatives

- **Dropping `--with-deps`.** It is what installs Playwright's actual library requirements on Linux,
  and the runner image is not guaranteed to carry them. Removing it trades a vendor outage for a
  library that may or may not be present — a worse failure, because it would be intermittent across
  image updates rather than obviously external.
- **Retrying the step.** A retry loop around a broken mirror is a fixed-duration wait wearing a hat
  (R159–R163), and the second run eight minutes later shows it would not have helped.
- **`apt-get update || true`.** Hides real failures of the sources that *are* needed.
- **Pinning or caching the Playwright browser.** Worth doing on its own merits for speed, and it does
  not address the `xvfb` step, so it is not this fix.

### 4b. The comment that had to change with it

`ci.yml` states that xvfb is "one of exactly two Linux-only steps". Adding a third makes that
sentence false, and a stale count in a comment nobody re-reads is how the four-places problem starts
(`CLAUDE.md`'s own history). The comment is updated in the same change and now enumerates all three.

## 5. Verification

**CI is the only place this can be verified**, since the failure is a property of the Linux runner
image and its network. The acceptance is therefore this round's own pull request: `ubuntu-latest`
reaching the test step and the suite passing on all three platforms.

That is weaker than inducing the original failure, and the reason is worth stating rather than
glossing: the trigger is a third-party mirror being inconsistent, which cannot be induced and will
not still be true when the fix is reviewed. What *can* be checked, and is: the step runs, prints the
remaining sources, and the two apt consumers after it succeed.

**A negative result is meaningful too.** If `ubuntu-latest` fails on the missing package this fix
would have to have removed, that is the alternative in §4a proving itself wrong in public, and the
log will name it.

## 6. Acceptance

1. `ubuntu-latest` completes `playwright install --with-deps` and `Install xvfb` and reaches the
   test step.
2. The suite passes on all three platforms, unchanged in content.
3. No step references Google's repository by filename.
4. The Linux-only step count in `ci.yml`'s comments matches reality.

## 7. Out of scope

Caching the Playwright browser download, pinning the runner image, and `release.yml`, which does not
run `playwright install` and is not affected. Whether the browser project should run on all three
platforms at all — it should; that is R151's finding and this round does not reopen it.

## 8. Version

No bump implied — CI infrastructure, no change to anything shipped.
