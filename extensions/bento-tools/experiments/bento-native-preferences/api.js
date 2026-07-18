'use strict';

/* globals ChromeUtils, ExtensionAPI, ExtensionCommon, Services */

const REQUEST_TOPIC = 'bento-native-preferences-request';
const RESPONSE_TOPIC = 'bento-native-preferences-response';
const PUBLICATION_TOPIC = 'bento-native-preferences-publication';

const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
  'resource://gre/modules/PrivateBrowsingUtils.sys.mjs',
);
const { BentoShellDocumentRegistry } = ChromeUtils.importESModule(
  'resource:///actors/BentoShellDocumentRegistry.sys.mjs',
);

function loadProtocol(extension) {
  const constantsScope = Object.create(null);
  const protocolScope = Object.create(null);
  Services.scriptloader.loadSubScript(
    extension.baseURI.resolve('experiments/bento-native-preferences/loader-contract-constants.js'),
    constantsScope,
  );
  Services.scriptloader.loadSubScript(
    extension.baseURI.resolve('experiments/bento-native-preferences/generated-protocol.js'),
    protocolScope,
  );
  const constants = constantsScope.BentoNativePreferencesLoaderContract;
  const protocol = protocolScope.BentoNativePreferencesProtocol;
  if (
    !constants ||
    !protocol ||
    Object.keys(constants).length !== 3 ||
    constants.protocolVersion !== protocol.PROTOCOL_VERSION ||
    constants.generatorVersion !== protocol.GENERATOR_VERSION ||
    constants.expectedContractSha256 !== protocol.CONTRACT_SHA256
  ) {
    throw new Error('Bento native preferences protocol artifacts do not match.');
  }
  return protocol;
}

function unwrapSubject(subject) {
  const value = subject?.wrappedJSObject;
  if (!value || typeof value !== 'object') throw new Error('Invalid native request subject.');
  return value;
}

function validateDocumentSubject(value, context) {
  const document = value.document;
  const chromeWindow = value.chromeWindow;
  if (!document || !chromeWindow || document.nodePrincipal?.isSystemPrincipal !== true) {
    throw new Error('Native preferences request is not system-principal.');
  }
  const href = String(document.location?.href || '');
  if (!href.startsWith('about:preferences') && !href.startsWith('about:settings')) {
    throw new Error('Native preferences request came from an unauthorized document.');
  }
  const wrapper = context.extension.windowManager.getWrapper(chromeWindow);
  if (!wrapper || !Number.isInteger(wrapper.id) || wrapper.id <= 0) {
    throw new Error('Native preferences request has no live browser window.');
  }
  return {
    targetWindowId: wrapper.id,
    isPrivate: PrivateBrowsingUtils.isWindowPrivate(chromeWindow),
  };
}

this.bentoNativePreferences = class extends ExtensionAPI {
  getAPI(context) {
    const protocol = loadProtocol(this.extension);
    const pendingSubjects = new Map();
    let observer = null;

    context.callOnClose({
      close() {
        if (observer) Services.obs.removeObserver(observer, REQUEST_TOPIC);
        observer = null;
        pendingSubjects.clear();
      },
    });

    return {
      bentoNativePreferences: {
        onRequest: new ExtensionCommon.EventManager({
          context,
          name: 'bentoNativePreferences.onRequest',
          register: (fire) => {
            if (observer)
              throw new Error('Only one native preferences request listener is allowed.');
            observer = (subject) => {
              try {
                const value = unwrapSubject(subject);
                const authority = validateDocumentSubject(value, context);
                // Observer subjects cross a compartment boundary. Normalize the
                // data-only envelope into this experiment's realm before the
                // generated validator applies its strict plain-object checks.
                const request = JSON.parse(JSON.stringify(value.request));
                if (!protocol.validateEnvelope(request)) return;
                const key = `${request.clientInstanceId}:${request.requestId}`;
                pendingSubjects.set(key, subject);
                void fire.async({ request, ...authority });
              } catch (error) {
                // Invalid subjects fail closed and never reach the background. Log only
                // the fixed validation error, never the request payload.
                console.warn('[bento-tools] rejected native preferences request:', String(error));
              }
            };
            Services.obs.addObserver(observer, REQUEST_TOPIC);
            return () => {
              if (observer) Services.obs.removeObserver(observer, REQUEST_TOPIC);
              observer = null;
              pendingSubjects.clear();
            };
          },
        }).api(),

        async respond(response) {
          if (!response || typeof response !== 'object') return false;
          const key = `${response.clientInstanceId}:${response.requestId}`;
          const subject = pendingSubjects.get(key);
          if (!subject) return false;
          pendingSubjects.delete(key);
          Services.obs.notifyObservers(subject, RESPONSE_TOPIC, JSON.stringify(response));
          return true;
        },

        async publish(publication) {
          if (!publication || publication.contractHash !== protocol.CONTRACT_SHA256) {
            throw new Error('Invalid native preferences publication.');
          }
          Services.obs.notifyObservers(null, PUBLICATION_TOPIC, JSON.stringify(publication));
        },

        async getCurrentBootAttestation(...args) {
          if (args.length !== 0) throw new Error('getCurrentBootAttestation accepts no arguments.');
          const value = BentoShellDocumentRegistry.getCurrentBootAttestation();
          const keys = Object.keys(value).sort();
          if (
            keys.join(',') !==
              'currentBootId,currentParentSessionId,registryEpoch,singletonInitializedAt' ||
            typeof value.currentParentSessionId !== 'string' ||
            typeof value.currentBootId !== 'string' ||
            !Number.isSafeInteger(value.singletonInitializedAt) ||
            !Number.isSafeInteger(value.registryEpoch)
          ) {
            throw new Error('Malformed Bento parent-process attestation.');
          }
          return value;
        },
      },
    };
  }
};
