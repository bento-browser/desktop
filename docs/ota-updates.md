# OTA updates: update service and publishing

Bento's updater is still compiled out (see [Updater](build-tooling.md#updater)), so nothing
on this page is reachable from a shipped build yet. This page covers the two
pieces that sit between a release build and an installed Bento: the update
metadata service that answers Firefox's update check, and the publish script
that puts a release behind it. Both run against a test environment first.

- The service is a Cloudflare Worker, `update-service/`. It is plain JavaScript
  with no dependencies and is deployed with `wrangler`, which `ota-publish` runs
  as `pnpm dlx wrangler@<exact version>`.
- Artifacts (the MAR and the DMG) are immutable objects in R2, served from a
  download host. The Worker never proxies them.
- [`scripts/ota-publish.mjs`](../scripts/ota-publish.mjs) is the only thing that
  uploads or deploys. It runs on the maintainer's Mac; CI refuses it
  (`pnpm run security:check`).

## Service contract

Firefox asks the update host for

```text
/update/6/%PRODUCT%/%VERSION%/%BUILD_ID%/%BUILD_TARGET%/%LOCALE%/%CHANNEL%/%OS_VERSION%/%SYSTEM_CAPABILITIES%/%DISTRIBUTION%/%DISTRIBUTION_VERSION%/update.xml
```

The ten fields are filled in by the client. The Worker reads `product`,
`version`, `target` and `channel`; it decodes the others leniently and ignores
them (`%OS_VERSION%` arrives encoded twice). The query string is ignored:
foreground checks add `force=1`.

| Request                                                                                                                                                                              | Response                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Serving, product `Bento`, target `Darwin_aarch64-gcc3`, channel `bento`, and the release's version is strictly higher than the client's                                              | 200 `text/xml`, one `<update>` with one complete `<patch>` |
| Any other well-formed update check: equal or newer client, another product, target or channel, a client version that is not `major.minor.patch` digits, `serving: false`, no release | 200 `text/xml`, `<updates/>`                               |
| A path that is not an update check                                                                                                                                                   | 400 `text/plain`                                           |
| A method other than GET and HEAD                                                                                                                                                     | 405 `text/plain`                                           |

Every response carries `Cache-Control: no-store`. The split matters because
Firefox 158 reads a well-formed `<updates/>` as "no update" and a non-XML body
as a failed check that the user can see, so an unrecognized client is told "no
update" and only a request that is not an update check at all gets a plain-text 400.

The offer carries `type`, `displayVersion`, `appVersion`, `platformVersion`,
`buildID` and `detailsURL` on `<update>`, and `type="complete"`, `URL`, `size`,
`hashFunction="sha512"` and `hashValue` on `<patch>`. `type` is `major` when the
release's major version is higher than the client's and `minor` otherwise;
Firefox 158 only uses it to prefer a minor update over a major one. Firefox
verifies the size and, when it applies the update, the MAR signature; it never
checks `hashValue`. Every value is XML-escaped.

Versions are compared numerically as `major.minor.patch`, and only the version
decides: the client's BuildID is not consulted. This is safe because a version
is never republished. The client would accept a same-version rebuild with a
different BuildID, but the Worker never offers one, and a MAR whose version is
lower than the installed updater's is refused when applied. Every published
build therefore gets a unique, strictly higher patch version.

## Release descriptor

Each environment has one committed descriptor, `update-service/releases/<env>.json`,
holding at most one current release. `serving: false` and `release: null` is the
state of both files today.

```json
{
  "serving": true,
  "product": "Bento",
  "target": "Darwin_aarch64-gcc3",
  "channel": "bento",
  "release": {
    "version": "0.1.0",
    "buildId": "20261102120000",
    "marUrl": "https://downloads.bentobrowser.app/Bento-0.1.0-20261102120000-macos-arm64.mar",
    "size": 123456789,
    "sha512": "<128 lowercase hex characters>",
    "platformVersion": "158.0",
    "detailsUrl": "https://bentobrowser.app/release-notes/0.1.0/"
  }
}
```

| Field                          | Rule                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `serving`                      | Boolean. `false` makes the Worker answer `<updates/>` to everyone.                       |
| `product`, `target`, `channel` | Exactly `Bento`, `Darwin_aarch64-gcc3`, `bento`. They are the allowlist.                 |
| `release`                      | An object with exactly the fields below, or `null`. `serving: true` needs a release.     |
| `release.version`              | `major.minor.patch` digits.                                                              |
| `release.buildId`              | The 14-digit Firefox BuildID of the packaged app.                                        |
| `release.marUrl`               | An https URL without credentials, ending in `Bento-<version>-<buildId>-macos-arm64.mar`. |
| `release.size`                 | The MAR's exact size in bytes.                                                           |
| `release.sha512`               | The MAR's SHA-512, lowercase hex.                                                        |
| `release.platformVersion`      | The Firefox version, dotted digits.                                                      |
| `release.detailsUrl`           | An https URL without credentials, the release notes page.                                |

Unknown fields and missing fields are both errors. The descriptor is validated
by `validateDescriptor` in
[`update-service/descriptor.mjs`](../update-service/descriptor.mjs) in three
places: the Worker's entry module validates it when the script loads, so an
invalid descriptor fails the deploy and not the first request;
`ota-publish` validates what it writes before writing it; and the tests
validate the committed files.

## Environments

|                                    | test                                | production                                |
| ---------------------------------- | ----------------------------------- | ----------------------------------------- |
| Update host (Worker Custom Domain) | `updates-test.bentobrowser.app`     | `updates.bentobrowser.app`                |
| Worker                             | `bento-update-service-test`         | `bento-update-service-production`         |
| Descriptor                         | `update-service/releases/test.json` | `update-service/releases/production.json` |
| R2 bucket                          | `bento-updates-test`                | `bento-updates`                           |
| Download host                      | `downloads-test.bentobrowser.app`   | `downloads.bentobrowser.app`              |

The test hosts are meant to answer only Andrew's IP (a WAF rule), and neither
bucket has `r2.dev` access. Those rules, the buckets, the download custom
domains and the API token are Cloudflare resources created outside this
repository. The token needs Workers and R2 edit access on the account;
`ota-publish` reads it and the account id from `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`, and nothing is committed.

[`update-service/wrangler.toml`](../update-service/wrangler.toml) defines one
Worker per environment, each with its Custom Domain, with `workers.dev` and
preview URLs off and request logging off. `wrangler deploy --env <env>`
creates the domain's DNS record, so a pre-existing DNS record for the hostname
has to be removed before the first deploy.

The descriptor is bundled at deploy time. `entry.mjs` imports the module name
`release-descriptor`, and each environment's `alias` table maps that name to its
own JSON file. This needs no build step and no extra files per environment;
the alternative, one entry file per environment, would duplicate the entry
code.

## Publishing

`ota-publish` takes `--env test|production` and these operations, none of which
the other environment ever sees:

```sh
node scripts/ota-publish.mjs --env test --assets --promote
node scripts/ota-publish.mjs --env production --assets --promote
node scripts/ota-publish.mjs --env production --withdraw
```

`--release-dir <dir>` points at an archived build instead of `release-out/`.

The build's output directory must hold `release-manifest.json` and exactly one
`Bento-<version>-<buildid>-macos-arm64.mar` with the `.dmg` of the same name.
Size and digests are computed from the files; the manifest is read for the
Firefox version and the signing record, and has to list both files with the
same SHA-256 and size.

- `--assets` uploads the MAR and the DMG with `wrangler r2 object put` (long
  immutable `Cache-Control`), then checks each object through the
  environment's download host: HEAD `Content-Length` equals the local size, a
  `Range: bytes=0-0` request answers 206, and a full GET has the local SHA-512.
  Objects are never overwritten: an object that already exists is accepted only
  when it passes the same check, otherwise the script stops. That makes a
  repeat run after a failed upload safe.
- `--promote` checks the hosted MAR the same way (skipped when `--assets` just
  did), rewrites `update-service/releases/<env>.json` from the build with the
  environment's download host and the release notes URL
  `https://bentobrowser.app/release-notes/<version>/`, and runs
  `wrangler deploy --env <env>`. The descriptor must not name a higher
  version, or the same version with another BuildID or MAR; the same release
  can be promoted again, for example after a withdrawal. The script leaves the
  rewritten descriptor in the working tree: commit it once the deploy worked.
- `--withdraw` sets `serving: false`, keeping the release on record, and
  deploys. It needs no build output and no gate.

Production operations other than `--withdraw` first run
`pnpm run release:security-check:public`, and then require all of:

- the build's `displayVersion` is at least 0.1.0, so private v0.0.X builds are
  never published;
- `release-manifest.json` has `signing.mode` of `developer-id` (a missing
  record counts as `ad-hoc`);
- `config/release-security.json` has an `updateService.roundTrip` record for
  this exact artifact: `toVersion` equals the version, `buildIds.to` the
  BuildID and `marSha256` the MAR's SHA-256. The record is written after the
  isolated round trip and also holds `date`, `fromVersion`, `buildIds.from` and
  `host`:

  ```json
  "roundTrip": {
    "date": "2026-11-20",
    "fromVersion": "0.0.2",
    "toVersion": "0.1.0",
    "buildIds": { "from": "20260901000000", "to": "20261102120000" },
    "marSha256": "<64 lowercase hex characters>",
    "host": "updates-test.bentobrowser.app"
  }
  ```

### Runbook

1. Bump `brands.bento.release.displayVersion` (patch only), write the release
   notes page, and build the release (`pnpm run build:release`). Archive the
   previous `release-out/` first.
2. `node scripts/ota-publish.mjs --env test --assets --promote`.
3. On the test account, check from the previous version and confirm the update
   applies (see the next section); run the curl checks below.
4. `node scripts/ota-publish.mjs --env production --assets --promote`, then
   commit both descriptors, tag `v<version>` and update the site's download
   link.
5. If anything is wrong, `node scripts/ota-publish.mjs --env production
--withdraw`, then ship a fix as a new, higher version. Never serve an older
   version: clients and the updater reject it, and a staged update cannot be
   recalled. The fix is a rebuild of the last good tree under a higher version
   and BuildID. Users who need to go back reinstall from the download page.

A failed deploy leaves the rewritten descriptor in the working tree and not
live; run `--promote` again (the same release is allowed). If `--assets` stops
on an existing object that does not match the local file, nothing has been
offered from it unless it was promoted, so delete it with
`pnpm dlx wrangler@<version> r2 object delete <bucket>/<name> --remote` and run
again. An object that was promoted and is wrong cannot be reused: publish a new,
higher version.

`wrangler r2 object put` uploads a file in one request, which Cloudflare limits
to roughly 300 MB. A MAR or DMG above that needs the S3-compatible API, which
this script does not implement. Check the figure in Cloudflare's R2 documentation
before the first real upload.

## Checking an environment

From a machine the environment allows (the test hosts answer only Andrew's IP):

```sh
HOST=updates-test.bentobrowser.app
OS='Darwin%2520Kernel%252027.0.0'
CAPS='ISET%3ANEON%2CMEM%3A16384'
URL="https://$HOST/update/6/Bento/0.0.1/20260101000000/Darwin_aarch64-gcc3/en-US/bento/$OS/$CAPS/default/default/update.xml"
curl -si "$URL?force=1"                                          # an older client: the offer
curl -si "${URL/0.0.1/9.9.9}"                                    # a newer client: <updates/>
curl -si "${URL/Darwin_aarch64-gcc3/Darwin_x86_64-gcc3}"         # another target: <updates/>
curl -si "https://$HOST/update/6/Bento/"                         # malformed: 400, text/plain
```

Every response must carry `cache-control: no-store`. While `serving` is false,
all of them except the 400 answer `<updates/>`. `downloads-test` must refuse
a request from outside the allowlist, and no `r2.dev` URL may answer.

### Pointing a real client at the test environment

Release builds compile `updates.bentobrowser.app` into the app and honor the
`AppUpdateURL` enterprise policy, so a build can be tested against
`updates-test` without changing its bytes. In a separate macOS user account,
with the app installed writable under that user's `~/Applications`:

1. Quit Bento.
2. In Terminal, run:

   ```sh
   defaults write app.bentobrowser.bento EnterprisePoliciesEnabled -bool true
   defaults write app.bentobrowser.bento AppUpdateURL -string "https://updates-test.bentobrowser.app/update/6/%PRODUCT%/%VERSION%/%BUILD_ID%/%BUILD_TARGET%/%LOCALE%/%CHANNEL%/%OS_VERSION%/%SYSTEM_CAPABILITIES%/%DISTRIBUTION%/%DISTRIBUTION_VERSION%/update.xml"
   ```

3. Launch Bento, open `about:policies`, and confirm `AppUpdateURL` is listed.
4. In the Browser Toolbox Console (Cmd+Opt+Shift+I), paste
   `await Cc["@mozilla.org/updates/update-checker;1"].getService(Ci.nsIUpdateChecker).getUpdateURL(Ci.nsIUpdateChecker.BACKGROUND_CHECK)`
   and confirm the result starts with `https://updates-test.bentobrowser.app/`.

`defaults delete app.bentobrowser.bento AppUpdateURL` undoes it.

## Privacy disclosure for cutover

Not published yet: the updater does not ship. When it does, add this to
[privacy.md](privacy.md) (adjust it to what the isolated round trip captured):

> ### Update checks
>
> Bento checks `updates.bentobrowser.app` for a new version shortly after
> startup and about every six hours. The request is a GET with no body and no
> cookie. Its address carries the app name, version and build ID, the Mac's
> CPU architecture, the app's locale and update channel, the macOS version, the
> CPU instruction set and memory size that Firefox reports (for example
> `ISET:NEON,MEM:16384`), and the distribution name and version (`default`).
> It carries no account or device identifier. Bento keeps no per-request log
> for this service and sees only aggregate request counts; Cloudflare hosts the
> domain and processes the connection under its own privacy policy. When an
> update is available, Bento downloads it from `downloads.bentobrowser.app`
> (Cloudflare R2). The update itself is checked against a signature key that
> is compiled into Bento before it is applied.
>
> Firefox's media component feed (Widevine and OpenH264) is a separate
> dependency on Mozilla: unless disabled, Bento asks `aus5.mozilla.org` for
> those components with its version, build ID, locale, operating system and
> channel.

## Pitfalls

- `pnpm dlx` may report ignored build scripts for `workerd` and `esbuild`
  because the workspace allows only `esbuild` to build. Wrangler is expected to
  run without them; if a deploy fails on that, add `--allow-build=workerd
--allow-build=esbuild` after `dlx` in the commands `ota-publish` builds.
- The service has no `package.json`, dependency or lockfile by design. `wrangler`
  is fetched by `pnpm dlx` at the version pinned as `WRANGLER_VERSION` in
  `scripts/ota-publish.mjs`; bump it deliberately and run the tests.
