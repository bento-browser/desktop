'use strict';

/* globals ChromeUtils, ExtensionAPI, ExtensionCommon */

const { BentoShellBusHub } = ChromeUtils.importESModule(
  'resource:///actors/BentoShellBusParent.sys.mjs',
);

this.bentoChrome = class extends ExtensionAPI {
  getAPI(context) {
    let modeOwner = null;
    return {
      bentoChrome: {
        // Shell bus relay (BentoShellBusParent.sys.mjs): upward messages from
        // documents the BroadcastChannel cannot reach, and targeted replies.
        onBusMessage: new ExtensionCommon.EventManager({
          context,
          name: 'bentoChrome.onBusMessage',
          register: (fire) => {
            const listener = (record) => void fire.async(record);
            modeOwner = listener;
            BentoShellBusHub.onUp(listener);
            return () => {
              if (modeOwner === listener) modeOwner = null;
              BentoShellBusHub.offUp(listener);
            };
          },
        }).api(),
        postToDocument: (documentId, message) =>
          BentoShellBusHub.postToDocument(documentId, message),
        replyModeState: (requestId, response) =>
          BentoShellBusHub.replyModeState(modeOwner, requestId, response),
      },
    };
  }
};
