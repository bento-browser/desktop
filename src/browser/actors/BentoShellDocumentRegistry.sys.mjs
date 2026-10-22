/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

function uuid() {
  return Services.uuid.generateUUID().toString().slice(1, -1);
}

function token() {
  return `${uuid().replaceAll("-", "")}${uuid().replaceAll("-", "")}`;
}

function cloneRecord(record) {
  return {
    mountToken: record.mountToken,
    clientInstanceId: record.clientInstanceId,
    leaseToken: record.leaseToken,
    entryKind: record.entryKind,
    role: record.role,
    windowId: record.windowId,
    isPrivate: record.isPrivate,
    registryRevision: record.registryRevision,
    chromeReady: record.chromeReady,
    hidden: record.hidden,
    lastAppliedTuple: record.lastAppliedTuple
      ? structuredClone(record.lastAppliedTuple)
      : null,
  };
}

class Registry {
  currentParentSessionId = uuid();
  registryEpoch = 0;
  rebindGeneration = 0;
  #documents = new Map();
  #listeners = new Map([
    ["mounted", new Set()],
    ["changed", new Set()],
    ["removed", new Set()],
  ]);
  #background = null;
  #transitions = [];

  on(kind, listener) {
    this.#listeners.get(kind)?.add(listener);
  }

  off(kind, listener) {
    this.#listeners.get(kind)?.delete(listener);
  }

  #emit(kind, record) {
    let snapshot = cloneRecord(record);
    for (let listener of this.#listeners.get(kind) || []) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error("Bento document registry listener failed", error);
      }
    }
  }

  registerDocument({ browser, chromeWindow, entryKind, role, windowId, isPrivate }) {
    if (!browser || !chromeWindow || !Number.isInteger(windowId)) {
      throw new Error("Invalid Bento shell document registration");
    }
    let existing = [...this.#documents.values()].find(
      record => record.browserRef?.deref() === browser
    );
    if (existing) {
      return cloneRecord(existing);
    }
    let mountToken = token();
    let record = {
      mountToken,
      clientInstanceId: uuid(),
      leaseToken: token(),
      browserRef: new WeakRef(browser),
      chromeWindowRef: new WeakRef(chromeWindow),
      entryKind,
      role: role || (entryKind === "sidebar" ? "primary" : "auxiliary"),
      windowId,
      isPrivate: !!isPrivate,
      registryRevision: ++this.registryEpoch,
      chromeReady: false,
      hidden: true,
      lastAppliedTuple: null,
    };
    this.#documents.set(mountToken, record);
    this.#emit("mounted", record);
    return cloneRecord(record);
  }

  removeDocument(mountToken) {
    let record = this.#documents.get(mountToken);
    if (!record) {
      return false;
    }
    this.#documents.delete(mountToken);
    record.registryRevision = ++this.registryEpoch;
    record.hidden = true;
    record.chromeReady = false;
    this.#emit("removed", record);
    return true;
  }

  listDocuments() {
    for (let [mountToken, record] of this.#documents) {
      if (!record.browserRef?.deref() || !record.chromeWindowRef?.deref()) {
        this.removeDocument(mountToken);
      }
    }
    return [...this.#documents.values()].map(cloneRecord);
  }

  bindBackground({ newBackgroundInstanceId }) {
    if (typeof newBackgroundInstanceId !== "string" || !newBackgroundInstanceId) {
      throw new Error("Invalid Bento shell background identity");
    }
    if (this.#background?.id === newBackgroundInstanceId) {
      return structuredClone(this.#background.attestation);
    }
    let fromBackgroundInstanceId = this.#background?.id;
    let generation = ++this.rebindGeneration;
    let transition = Object.freeze({
      parentSessionId: this.currentParentSessionId,
      generation,
      ...(fromBackgroundInstanceId ? { fromBackgroundInstanceId } : {}),
      toBackgroundInstanceId: newBackgroundInstanceId,
      fromRegistryEpoch: this.#background?.registryEpoch ?? this.registryEpoch,
      toRegistryEpoch: this.registryEpoch,
      issuedAt: Date.now(),
      proofToken: token(),
      clientsDigest: this.listDocuments()
        .map(record => `${record.clientInstanceId}:${record.registryRevision}`)
        .sort()
        .join("|"),
    });
    this.#transitions.push(transition);
    let attestation = Object.freeze({
      currentBackgroundInstanceId: newBackgroundInstanceId,
      currentRegistryEpoch: this.registryEpoch,
      currentGeneration: generation,
      currentAttestation: transition.proofToken,
    });
    this.#background = {
      id: newBackgroundInstanceId,
      registryEpoch: this.registryEpoch,
      attestation,
    };
    return structuredClone(attestation);
  }

  getRebindProofs() {
    return {
      ...(this.#background?.attestation || {}),
      transitions: this.#transitions.map(transition => structuredClone(transition)),
      clients: this.listDocuments(),
    };
  }

  ackRebindGeneration(generation) {
    if (!Number.isInteger(generation) || generation > this.rebindGeneration) {
      return false;
    }
    this.#transitions = this.#transitions.filter(
      transition => transition.generation >= generation
    );
    return true;
  }

  noteLifecycle(details) {
    let record = this.#documents.get(details?.mountToken);
    if (!record) {
      return null;
    }
    if (typeof details.chromeReady === "boolean") {
      record.chromeReady = details.chromeReady;
    }
    if (typeof details.hidden === "boolean") {
      record.hidden = details.hidden;
    }
    record.registryRevision = ++this.registryEpoch;
    this.#emit("changed", record);
    return cloneRecord(record);
  }

  recordChromeApplied(mountToken, tuple) {
    let record = this.#documents.get(mountToken);
    if (!record || !tuple) {
      return false;
    }
    record.lastAppliedTuple = structuredClone(tuple);
    record.chromeReady = true;
    record.hidden = false;
    record.registryRevision = ++this.registryEpoch;
    this.#emit("changed", record);
    return true;
  }

  invalidateDocument({ clientInstanceId, registryRevision }) {
    let record = [...this.#documents.values()].find(
      candidate => candidate.clientInstanceId === clientInstanceId
    );
    if (!record || record.registryRevision !== registryRevision) {
      return null;
    }
    record.hidden = true;
    record.chromeReady = false;
    record.registryRevision = ++this.registryEpoch;
    let proof = {
      clientInstanceId,
      windowId: record.windowId,
      registryRevision: record.registryRevision,
      proofSource: "parent-hidden",
      proofToken: token(),
    };
    this.#emit("changed", record);
    return proof;
  }
}

export const BentoShellDocumentRegistry = new Registry();
