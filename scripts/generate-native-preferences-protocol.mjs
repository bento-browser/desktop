#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH = path.join(REPO_ROOT, 'extensions/_shared/native-preferences-contract.json');

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function generatedRuntime(contract, hash, mode) {
  const exported = mode === 'raw' ? '' : 'export ';
  const typeSuffix = mode === 'typescript' ? ' as const' : '';
  const typecheckHeader =
    mode === 'typescript'
      ? '// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Generated runtime intentionally uses JavaScript-shaped dynamic types.\n// @ts-nocheck\n'
      : '';
  const suffix =
    mode === 'raw'
      ? '\nthis.BentoNativePreferencesProtocol = Object.freeze({ PROTOCOL_VERSION, CONTRACT_SHA256, GENERATOR_VERSION, CONTRACT, validateValue, validateSettingsChanges, validateAdvancedPrivacyChange, validateEnvelope });\n'
      : '';
  return `// GENERATED—DO NOT EDIT. Protocol ${contract.protocolVersion}; generator ${contract.generatorVersion}; SHA-256 ${hash}
${typecheckHeader}${exported}const PROTOCOL_VERSION = ${contract.protocolVersion};
${exported}const CONTRACT_SHA256 = '${hash}';
${exported}const GENERATOR_VERSION = ${contract.generatorVersion};
${exported}const CONTRACT = ${JSON.stringify(contract, null, 2)}${typeSuffix};

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

${exported}function validateValue(rule, value) {
  if (rule.type === 'boolean') return typeof value === 'boolean';
  if (rule.type === 'string') return typeof value === 'string' && value.length >= (rule.minLength ?? 0) && value.length <= (rule.maxLength ?? Number.MAX_SAFE_INTEGER);
  if (rule.type === 'integer') return Number.isInteger(value) && value >= rule.min && value <= rule.max;
  if (rule.type === 'enum') return typeof value === 'string' && rule.values.includes(value);
  if (rule.type === 'integerArray') return Array.isArray(value) && value.length <= rule.maxItems && value.every((entry) => Number.isInteger(entry) && entry >= rule.min && entry <= rule.max);
  return false;
}

${exported}function validateSettingsChanges(value) {
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 15) return false;
  return entries.every(([key, entry]) => Object.hasOwn(CONTRACT.editableSettings, key) && validateValue(CONTRACT.editableSettings[key], entry));
}

${exported}function validateAdvancedPrivacyChange(value) {
  if (!isPlainObject(value) || Object.keys(value).length !== 2 || typeof value.key !== 'string' || !Object.hasOwn(CONTRACT.advancedPrivacy, value.key)) return false;
  return Object.keys(value).every((key) => key === 'key' || key === 'value') && validateValue(CONTRACT.advancedPrivacy[value.key], value.value);
}

${exported}function validateEnvelope(value) {
  if (!isPlainObject(value) || value.protocolVersion !== PROTOCOL_VERSION || value.contractHash !== CONTRACT_SHA256 || typeof value.operation !== 'string' || !Object.hasOwn(CONTRACT.operations, value.operation)) return false;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const token = /^[A-Za-z0-9_-]{32,128}$/;
  if (typeof value.requestId !== 'string' || !uuid.test(value.requestId)) return false;
  if (typeof value.clientInstanceId !== 'string' || !uuid.test(value.clientInstanceId)) return false;
  if (!Number.isInteger(value.deadlineMs) || value.deadlineMs < CONTRACT.bounds.deadlineMs.min || value.deadlineMs > CONTRACT.bounds.deadlineMs.max) return false;
  if (!isPlainObject(value.payload)) return false;
  const operation = CONTRACT.operations[value.operation];
  const hello = value.operation === 'session/hello';
  const required = hello
    ? ['protocolVersion', 'contractHash', 'requestId', 'clientInstanceId', 'deadlineMs', 'operation', 'payload']
    : ['protocolVersion', 'contractHash', 'requestId', 'clientInstanceId', 'resumeToken', 'sequence', 'deadlineMs', 'operation', 'payload'];
  const optional = operation.operationId === 'required' ? ['operationId'] : [];
  const keys = Object.keys(value);
  if (!required.every((key) => Object.hasOwn(value, key)) || !keys.every((key) => required.includes(key) || optional.includes(key))) return false;
  if (hello) {
    const payloadKeys = Object.keys(value.payload);
    if (!payloadKeys.every((key) => key === 'resumeToken') || payloadKeys.length > 1) return false;
    if (Object.hasOwn(value.payload, 'resumeToken') && (typeof value.payload.resumeToken !== 'string' || !token.test(value.payload.resumeToken))) return false;
  } else {
    if (typeof value.resumeToken !== 'string' || !token.test(value.resumeToken)) return false;
    if (!Number.isInteger(value.sequence) || value.sequence < 0 || value.sequence > 2147483647) return false;
  }
  if (operation.operationId === 'required' && (typeof value.operationId !== 'string' || !uuid.test(value.operationId))) return false;
  if (operation.operationId === 'forbidden' && Object.hasOwn(value, 'operationId')) return false;
  return true;
}
${suffix}`;
}

function constantsRuntime(contract, hash) {
  return `// GENERATED—DO NOT EDIT. Protocol ${contract.protocolVersion}; generator ${contract.generatorVersion}; SHA-256 ${hash}\nthis.BentoNativePreferencesLoaderContract = Object.freeze({ protocolVersion: ${contract.protocolVersion}, expectedContractSha256: '${hash}', generatorVersion: ${contract.generatorVersion} });\n`;
}

function fixtures(contract, hash) {
  return `${JSON.stringify(
    canonicalize({
      contractHash: hash,
      protocolVersion: contract.protocolVersion,
      validSettingsChanges: Object.fromEntries(
        Object.entries(contract.editableSettings).map(([key, rule]) => [
          key,
          rule.type === 'boolean'
            ? true
            : rule.type === 'string'
              ? ''
              : rule.type === 'enum'
                ? rule.values[0]
                : rule.type === 'integerArray'
                  ? [rule.min]
                  : rule.min,
        ]),
      ),
      invalidSettingKeys: [
        'commandPaletteEnabled',
        'welcomeSeen',
        'contentColorMode',
        'sidebarCollapsed',
        'sidebarHidden',
        'privacyProtectionLevel',
        'defaultSearchEngine',
        'unknown',
      ],
      operations: Object.keys(contract.operations),
      errorCodes: contract.errorCodes,
      validHelloEnvelope: {
        protocolVersion: contract.protocolVersion,
        contractHash: hash,
        requestId: '11111111-1111-4111-8111-111111111111',
        clientInstanceId: '22222222-2222-4222-8222-222222222222',
        deadlineMs: 5000,
        operation: 'session/hello',
        payload: {},
      },
      validAuthenticatedEnvelope: {
        protocolVersion: contract.protocolVersion,
        contractHash: hash,
        requestId: '33333333-3333-4333-8333-333333333333',
        clientInstanceId: '22222222-2222-4222-8222-222222222222',
        resumeToken: 'abcdefghijklmnopqrstuvwxyzABCDEF',
        sequence: 0,
        deadlineMs: 5000,
        operation: 'snapshot/get',
        payload: { domains: ['settings'] },
      },
      invalidEnvelopeMutations: [
        'extra-top-level',
        'bad-client-id',
        'bad-token',
        'missing-sequence',
      ],
    }),
    null,
    2,
  )}\n`;
}

async function atomicWrite(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tempPath, bytes, 'utf8');
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

const args = new Set(process.argv.slice(2));
const write = args.has('--write');
const check = args.has('--check');
if (write === check) throw new Error('Pass exactly one of --write or --check');
const targetArg = process.argv.find((entry) => entry.startsWith('--targets='));
const targets = new Set((targetArg?.slice('--targets='.length) ?? 'tools,experiment').split(','));
const firefoxArg = process.argv.find((entry) => entry.startsWith('--firefox-root='));
const firefoxRoot = path.resolve(
  REPO_ROOT,
  firefoxArg?.slice('--firefox-root='.length) ?? 'engine',
);

const source = await readFile(CONTRACT_PATH, 'utf8');
const contract = canonicalize(JSON.parse(source));
const canonicalBytes = `${JSON.stringify(contract)}\n`;
const hash = createHash('sha256').update(canonicalBytes).digest('hex');
const outputs = new Map();
if (targets.has('tools')) {
  outputs.set(
    path.join(REPO_ROOT, 'extensions/_shared/generated/native-preferences-protocol.ts'),
    generatedRuntime(contract, hash, 'typescript'),
  );
  outputs.set(
    path.join(REPO_ROOT, 'extensions/_shared/generated/native-preferences-protocol-fixtures.json'),
    fixtures(contract, hash),
  );
}
if (targets.has('experiment')) {
  const root = path.join(REPO_ROOT, 'extensions/bento-tools/experiments/bento-native-preferences');
  outputs.set(path.join(root, 'generated-protocol.js'), generatedRuntime(contract, hash, 'raw'));
  outputs.set(path.join(root, 'loader-contract-constants.js'), constantsRuntime(contract, hash));
}
if (targets.has('firefox')) {
  const root = path.join(firefoxRoot, 'browser/components/preferences/bento/generated');
  outputs.set(
    path.join(root, 'BentoNativePreferencesProtocol.sys.mjs'),
    generatedRuntime(contract, hash, 'esm'),
  );
  outputs.set(
    path.join(root, 'native-preferences-protocol-fixtures.json'),
    fixtures(contract, hash),
  );
}

for (const [filePath, bytes] of outputs) {
  if (check) {
    const actual = await readFile(filePath, 'utf8').catch(() => null);
    if (actual !== bytes)
      throw new Error(`Generated protocol drift: ${path.relative(REPO_ROOT, filePath)}`);
  } else {
    await atomicWrite(filePath, bytes);
  }
}

process.stdout.write(
  `${check ? 'Checked' : 'Generated'} ${outputs.size} native preferences protocol artifacts (${hash}).\n`,
);
