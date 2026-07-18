'use strict';

/* globals ChromeUtils, ExtensionAPI, ExtensionCommon */

const { BentoShellDocumentRegistry } = ChromeUtils.importESModule(
  'resource:///actors/BentoShellDocumentRegistry.sys.mjs',
);

function registryEvent(context, name, add, remove) {
  return new ExtensionCommon.EventManager({
    context,
    name: `bentoChrome.${name}`,
    register: (fire) => {
      const listener = (record) => void fire.async(record);
      add(listener);
      return () => remove(listener);
    },
  }).api();
}

this.bentoChrome = class extends ExtensionAPI {
  getAPI(context) {
    return {
      bentoChrome: {
        bindBackground: (details) => BentoShellDocumentRegistry.bindBackground(details),
        getRebindProofs: () => BentoShellDocumentRegistry.getRebindProofs(),
        ackRebindGeneration: (generation) =>
          BentoShellDocumentRegistry.ackRebindGeneration(generation),
        listDocuments: () => BentoShellDocumentRegistry.listDocuments(),
        noteLifecycle: (details) => BentoShellDocumentRegistry.noteLifecycle(details),
        invalidateDocument: (details) => BentoShellDocumentRegistry.invalidateDocument(details),
        onDocumentMounted: registryEvent(
          context,
          'onDocumentMounted',
          (listener) => BentoShellDocumentRegistry.on('mounted', listener),
          (listener) => BentoShellDocumentRegistry.off('mounted', listener),
        ),
        onDocumentChanged: registryEvent(
          context,
          'onDocumentChanged',
          (listener) => BentoShellDocumentRegistry.on('changed', listener),
          (listener) => BentoShellDocumentRegistry.off('changed', listener),
        ),
        onDocumentRemoved: registryEvent(
          context,
          'onDocumentRemoved',
          (listener) => BentoShellDocumentRegistry.on('removed', listener),
          (listener) => BentoShellDocumentRegistry.off('removed', listener),
        ),
      },
    };
  }
};
