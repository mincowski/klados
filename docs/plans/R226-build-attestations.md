# R226 — GitHub attestations for every release file

<!-- status: open -->

**Open — recorded, not scheduled.** Written at the project lead's request alongside R225, so the
option is on record. Whether it is built is undecided.

## 1. What it is, and what it buys

**An attestation is a signed, public record** that one exact release file (by SHA-256) was built by a
named GitHub Actions workflow in `mincowski/klados`, from a named commit, triggered by a named event.
GitHub signs it through Sigstore with a short-lived certificate bound to the workflow's identity, so
there is no key to keep. For a public repository the record also goes into Sigstore's public,
append-only transparency log. It is free for public repositories.

**What it adds over `SHA256SUMS.txt`** (R167):
- The checksums file sits in the same release as the files it describes. Anyone able to replace a
  release asset, with a stolen token for instance, could replace the checksums with it.
- An attestation is bound to the workflow's identity and to the public log. A file built by hand, or
  replaced afterwards, does not verify.
- It also states *which commit* the file was built from: provenance, not only integrity.

**Where it fits:**
- **Pseudonymity:** the identity is the repository and its workflow, never a person's name (R140,
  R172).
- **Coverage:** every platform's files, the Mac and Linux packages included.

**What it does not do:**
- GitHub's words: *"Artifact attestations are not a guarantee that an artifact is secure."* Whatever
  is in the source is faithfully attested.
- **Windows and macOS do not read attestations**, so SmartScreen and Smart App Control behave exactly
  as without them.
- Only someone who chooses to verify benefits.

## 2. The change

- **In `release.yml`'s build jobs:**
  - permissions `id-token: write` and `attestations: write`;
  - after `electron-builder` has written the files, one `actions/attest` step naming them: the
    installer, the two dmgs, the AppImage and the .deb.

  The attested file is the one electron-builder uploads, byte for byte.
- **Tag builds only.** A `workflow_dispatch` rehearsal (D-095) publishes nothing, so attesting it
  would put records in the public log for files nobody can download.
- **`SHA256SUMS.txt` stays.** It needs no tooling to check, and the two answer different questions.
- **The README** gains one verification line next to the checksums:
  `gh attestation verify <file> --repo mincowski/klados`.

## 3. Verification

- After the first tagged release with it:
  - download every asset and run `gh attestation verify` on each; all pass;
  - change one byte of a copy; it fails.
- The attestation's record names the release tag's commit and `release.yml`.
- A rehearsal run creates no attestation.
