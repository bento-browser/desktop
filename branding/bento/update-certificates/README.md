# Bento update certificates

The two public certificates the Firefox updater compiles in as its MAR trust
anchors for the `bento` update channel. `patches/experiments/04-updater-bento-certificates.patch`
selects them in `toolkit/mozapps/update/updater/moz.build`, and `pnpm run import`
copies this directory into `engine/browser/branding/bento/` with the rest of the
branding. Only public material lives here.

| File            | Role                              | Subject                                  | SHA-256 of the DER file                                            |
| --------------- | --------------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `primary.der`   | Active key, signs every MAR       | `CN=Bento MAR Signing A,O=Bento Browser` | `18fa7002f1cd50738ab0255e3d5f2c8fa46c6891b8d1a3e5c4ff0f3211b61d9c` |
| `secondary.der` | Offline backup, signs nothing now | `CN=Bento MAR Signing B,O=Bento Browser` | `e7a6ac48aa9efcf2cf93e2c5752ee5844f3e40e29dce11a19eaa632a52623b35` |

Both are self-signed RSA-4096 certificates with SHA-384 signatures, valid for ten
years from 2026-11-01 16:00 UTC (generated 2026-11-02, NSS `certutil`, serial 1).
The macOS MAR verifier uses only the public key and ignores the validity dates.

The updater accepts a MAR that verifies against either certificate, one per
attempt, so a MAR carries exactly one signature, made with the active key. The
backup key lets a release signed with it introduce a new active key if the active
one is lost.

The private keys live in password-protected NSS databases outside every
repository. Never add a key database, password or export to this repository.

`config/release-security.json` records both fingerprints, and
`pnpm run release:security-check` fails if they stop matching these files.
Replacing a certificate means replacing the file and its fingerprint in the same
change, and repeating the isolated update round trip. See [docs/build-tooling.md](../../../docs/build-tooling.md#updater).
