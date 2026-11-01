// Test support for the updater checks: stand-in update certificates and the files an
// updater-enabled build ships, so bento-build.test.mjs and
// validate-bento-artifacts.test.mjs can exercise the artifact checks without Firefox.

import fs from 'node:fs';
import path from 'node:path';

export const CERTIFICATES = {
  primary: Buffer.from('test primary certificate'),
  secondary: Buffer.from('test secondary certificate'),
};

/** Writes the stand-in certificates where the repository commits Bento's. */
export function writeCertificates(root) {
  const directory = path.join(root, 'branding', 'bento', 'update-certificates');
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, bytes] of Object.entries(CERTIFICATES)) fs.writeFileSync(path.join(directory, `${name}.der`), bytes);
}

/**
 * Writes what an updater-enabled build ships beside the application the fixture already
 * made: the update URL in the generated and packaged application.ini and in the main
 * binary, both certificates in the updater, and (in an app bundle) UpdateSettings.framework
 * with its executable.
 */
export function shipUpdater({ application, objDist, hostname = 'updates.example.invalid', binaryName = 'bento' }) {
  const bundle = path.basename(application).endsWith('.app');
  const exe = process.platform === 'win32' ? '.exe' : '';
  const resources = bundle ? path.join(application, 'Contents', 'Resources') : application;
  const executables = bundle ? path.join(application, 'Contents', 'MacOS') : application;
  const updaterApp = path.join(executables, 'updater.app');
  const url = `https://${hostname}/update/6/`;

  const section = `[AppUpdate]\nURL=${url}%PRODUCT%/%VERSION%/update.xml\n`;
  fs.mkdirSync(path.join(objDist, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(objDist, 'bin', 'application.ini'), `[App]\nBuildID=20260912000000\n${section}`);
  fs.appendFileSync(path.join(resources, 'application.ini'), section);

  fs.mkdirSync(executables, { recursive: true });
  fs.writeFileSync(path.join(executables, `${binaryName}${exe}`), Buffer.from(`\0${url}%PRODUCT%\0`));
  const updaterDirectory = bundle ? path.join(updaterApp, 'Contents', 'MacOS') : application;
  fs.mkdirSync(updaterDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(updaterDirectory, bundle ? 'org.mozilla.updater' : `updater${exe}`),
    Buffer.concat([CERTIFICATES.primary, Buffer.from('\0'), CERTIFICATES.secondary]),
  );
  if (bundle) {
    // The layout updater/moz.build gives the bundle: the framework executable and its Info.plist.
    const framework = path.join(updaterApp, 'Contents', 'Frameworks', 'UpdateSettings.framework');
    fs.mkdirSync(path.join(framework, 'Resources'), { recursive: true });
    fs.writeFileSync(path.join(framework, 'UpdateSettings'), 'framework executable');
    fs.writeFileSync(path.join(framework, 'Resources', 'Info.plist'), '<plist/>');
  }
}
