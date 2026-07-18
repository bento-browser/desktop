// GENERATED—DO NOT EDIT. Protocol 1; generator 2; SHA-256 d7945bc9f4a5271537d6c66a16a583562c2f9a5a9088be2b2ea3b7dd04c9c705
const PROTOCOL_VERSION = 1;
const CONTRACT_SHA256 = 'd7945bc9f4a5271537d6c66a16a583562c2f9a5a9088be2b2ea3b7dd04c9c705';
const GENERATOR_VERSION = 2;
const CONTRACT = {
  "advancedPrivacy": {
    "diskCacheEnabled": {
      "type": "boolean"
    },
    "drmEnabled": {
      "type": "boolean"
    },
    "formHistoryEnabled": {
      "type": "boolean"
    },
    "httpsOnlyMode": {
      "type": "enum",
      "values": [
        "never",
        "always"
      ]
    },
    "letterboxing": {
      "type": "boolean"
    },
    "networkPrediction": {
      "type": "boolean"
    },
    "passwordSavingEnabled": {
      "type": "boolean"
    },
    "peerConnection": {
      "type": "boolean"
    },
    "remoteSafeBrowsingEnabled": {
      "type": "boolean"
    },
    "resistFingerprinting": {
      "type": "boolean"
    },
    "safeBrowsingEnabled": {
      "type": "boolean"
    },
    "sanitizeOnShutdown": {
      "type": "boolean"
    },
    "webRTCIPHandlingPolicy": {
      "type": "enum",
      "values": [
        "default",
        "disable_non_proxied_udp"
      ]
    },
    "webglEnabled": {
      "type": "boolean"
    },
    "webgpuEnabled": {
      "type": "boolean"
    }
  },
  "bounds": {
    "backupFileBytes": 10485760,
    "deadlineMs": {
      "max": 120000,
      "min": 1000
    },
    "nameCodeUnits": 1024,
    "sourceIdCodeUnits": 256,
    "workspaceCount": 256
  },
  "editableSettings": {
    "autoBackupEnabled": {
      "type": "boolean"
    },
    "autoBackupIntervalMinutes": {
      "max": 1440,
      "min": 5,
      "type": "integer"
    },
    "autoBackupMaxCount": {
      "max": 20,
      "min": 1,
      "type": "integer"
    },
    "customPanelSizes": {
      "max": 2400,
      "maxItems": 64,
      "min": 120,
      "type": "integerArray"
    },
    "defaultPanelWidthPx": {
      "max": 2400,
      "min": 200,
      "type": "integer"
    },
    "defaultWorkspaceName": {
      "maxLength": 1024,
      "minLength": 0,
      "type": "string"
    },
    "panelCornerRadiusPx": {
      "max": 36,
      "min": 0,
      "type": "integer"
    },
    "panelCycleWraparound": {
      "type": "boolean"
    },
    "panelShadowsEnabled": {
      "type": "boolean"
    },
    "panelSplitterSizePx": {
      "max": 36,
      "min": 6,
      "type": "integer"
    },
    "sidebarShortcutBehavior": {
      "type": "enum",
      "values": [
        "collapse",
        "hide"
      ]
    },
    "tabSleepAfterMinutes": {
      "max": 1440,
      "min": 1,
      "type": "integer"
    },
    "tabSleepEnabled": {
      "type": "boolean"
    },
    "tabSleepKeepAlivePerWorkspace": {
      "max": 50,
      "min": 1,
      "type": "integer"
    },
    "uiColorMode": {
      "type": "enum",
      "values": [
        "light",
        "dark",
        "system"
      ]
    }
  },
  "errorCodes": [
    "invalid_envelope",
    "unsupported_version",
    "unauthorized_document",
    "invalid_session",
    "session_expired",
    "parent_restarted",
    "session_window_mismatch",
    "private_window_forbidden",
    "invalid_payload",
    "payload_too_large",
    "not_found",
    "conflict",
    "busy",
    "deadline_exceeded",
    "cancelled",
    "backend_restarted",
    "persistence_failed",
    "live_effect_failed",
    "snapshot_changed",
    "target_window_unavailable",
    "validation_token_invalid",
    "validation_token_expired",
    "validation_token_used",
    "operation_unknown",
    "operation_not_owned",
    "operation_not_reconcilable",
    "graph_reserved",
    "internal_error"
  ],
  "fluentIds": [
    "bento-error-invalid-envelope",
    "bento-error-unsupported-version",
    "bento-error-invalid-session",
    "bento-error-private-window-forbidden",
    "bento-error-persistence-failed",
    "bento-error-target-window-unavailable",
    "bento-error-internal"
  ],
  "generatorVersion": 2,
  "journalPhases": [
    "prepared",
    "creating-workspaces",
    "creating-tabs",
    "staged",
    "graph-subcommitted",
    "relocating",
    "proving",
    "cleaning-old",
    "publishing",
    "awaiting-acks",
    "graph-published",
    "applying-saved-panels",
    "applying-settings",
    "applying-privacy",
    "applying-search",
    "terminal"
  ],
  "operationComponents": [
    "settings",
    "privacy",
    "search",
    "savedPanels",
    "graphStage",
    "graphPersistence",
    "tabRelocation",
    "guards",
    "ownershipProof",
    "usableTabProof",
    "panelSync",
    "oldGraphCleanup",
    "backupRecord"
  ],
  "operationStates": [
    "reserved",
    "running",
    "partial",
    "succeeded",
    "failed",
    "cancelled"
  ],
  "operations": {
    "backup/delete": {
      "authenticated": true,
      "operationId": "required",
      "private": false
    },
    "backup/export": {
      "authenticated": true,
      "operationId": "forbidden",
      "private": false
    },
    "backup/getContext": {
      "authenticated": true,
      "operationId": "forbidden",
      "private": false
    },
    "backup/importValidated": {
      "authenticated": true,
      "operationId": "required",
      "private": false
    },
    "backup/restore": {
      "authenticated": true,
      "operationId": "required",
      "private": false
    },
    "backup/validateImport": {
      "authenticated": true,
      "operationId": "forbidden",
      "private": false
    },
    "operation/reconcile": {
      "authenticated": true,
      "operationId": "forbidden",
      "private": true
    },
    "operation/status": {
      "authenticated": true,
      "operationId": "forbidden",
      "private": true
    },
    "privacy/setAdvanced": {
      "authenticated": true,
      "operationId": "forbidden",
      "private": true
    },
    "privacy/setDefaultSearchEngine": {
      "authenticated": true,
      "operationId": "forbidden",
      "private": true
    },
    "privacy/setProtectionLevel": {
      "authenticated": true,
      "operationId": "forbidden",
      "private": true
    },
    "recovery/acknowledgeNotice": {
      "authenticated": true,
      "operationId": "forbidden",
      "private": false
    },
    "request/cancel": {
      "authenticated": true,
      "operationId": "forbidden",
      "private": true
    },
    "session/close": {
      "authenticated": true,
      "operationId": "forbidden",
      "private": true
    },
    "session/hello": {
      "authenticated": false,
      "operationId": "forbidden",
      "private": true
    },
    "session/renew": {
      "authenticated": true,
      "operationId": "forbidden",
      "private": true
    },
    "settings/reset": {
      "authenticated": true,
      "operationId": "required",
      "private": true
    },
    "settings/update": {
      "authenticated": true,
      "operationId": "forbidden",
      "private": true
    },
    "snapshot/get": {
      "authenticated": true,
      "operationId": "forbidden",
      "private": true
    }
  },
  "protocolVersion": 1,
  "publicationDomains": [
    "settings",
    "privacy",
    "search",
    "backup"
  ],
  "session": {
    "absoluteMs": 28800000,
    "idleMs": 900000,
    "sequenceMax": 2147483647,
    "validationTokenMs": 300000
  },
  "shellWireDiscriminants": [
    "shell-client/background-rebind",
    "shell-client/rebind-accepted",
    "shell-client/register",
    "shell-client/ready",
    "shell-client/heartbeat",
    "shell-client/hidden",
    "shell-client/bye",
    "shell-client/action",
    "shell-client/event",
    "shell-client/delivery",
    "shell-client/safe-invalidated"
  ]
};

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateValue(rule, value) {
  if (rule.type === 'boolean') return typeof value === 'boolean';
  if (rule.type === 'string') return typeof value === 'string' && value.length >= (rule.minLength ?? 0) && value.length <= (rule.maxLength ?? Number.MAX_SAFE_INTEGER);
  if (rule.type === 'integer') return Number.isInteger(value) && value >= rule.min && value <= rule.max;
  if (rule.type === 'enum') return typeof value === 'string' && rule.values.includes(value);
  if (rule.type === 'integerArray') return Array.isArray(value) && value.length <= rule.maxItems && value.every((entry) => Number.isInteger(entry) && entry >= rule.min && entry <= rule.max);
  return false;
}

function validateSettingsChanges(value) {
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 15) return false;
  return entries.every(([key, entry]) => Object.hasOwn(CONTRACT.editableSettings, key) && validateValue(CONTRACT.editableSettings[key], entry));
}

function validateAdvancedPrivacyChange(value) {
  if (!isPlainObject(value) || Object.keys(value).length !== 2 || typeof value.key !== 'string' || !Object.hasOwn(CONTRACT.advancedPrivacy, value.key)) return false;
  return Object.keys(value).every((key) => key === 'key' || key === 'value') && validateValue(CONTRACT.advancedPrivacy[value.key], value.value);
}

function validateEnvelope(value) {
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

this.BentoNativePreferencesProtocol = Object.freeze({ PROTOCOL_VERSION, CONTRACT_SHA256, GENERATOR_VERSION, CONTRACT, validateValue, validateSettingsChanges, validateAdvancedPrivacyChange, validateEnvelope });
