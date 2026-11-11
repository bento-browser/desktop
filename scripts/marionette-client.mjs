// Minimal Marionette (protocol 3) client over a TCP socket, with no dependencies.
// Used by scripts/panel-suite.mjs to drive a locally launched Bento build.
//
// Wire format: every message is `<byte length>:<JSON>` in both directions. The
// server first sends a hello object, then answers each command
// `[0, id, name, params]` with `[1, id, error, result]`; `error` is null on
// success.

import net from 'node:net';

// A length prefix is at most a few digits; more than this without a ':' means
// the stream is not Marionette.
const MAX_HEADER_BYTES = 16;

/** Encodes one message as `<byte length>:<JSON>`. The length counts bytes, not characters. */
export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`${body.length}:`, 'ascii'), body]);
}

/**
 * Incremental decoder. `push(chunk)` takes the next bytes from the socket, in
 * whatever pieces they arrive, and returns the messages completed by them.
 */
export class FrameParser {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const messages = [];
    for (;;) {
      const colon = this.#buffer.indexOf(0x3a);
      if (colon === -1) {
        if (this.#buffer.length > MAX_HEADER_BYTES) {
          throw new Error('Marionette frame has no length prefix');
        }
        break;
      }
      const header = this.#buffer.subarray(0, colon).toString('ascii');
      if (!/^\d+$/.test(header)) {
        throw new Error(`Marionette frame has a bad length prefix: ${JSON.stringify(header)}`);
      }
      const end = colon + 1 + Number(header);
      if (this.#buffer.length < end) break;
      messages.push(JSON.parse(this.#buffer.subarray(colon + 1, end).toString('utf8')));
      this.#buffer = this.#buffer.subarray(end);
    }
    return messages;
  }
}

/** A command the server answered with an error. */
export class MarionetteError extends Error {
  constructor(command, detail) {
    super(
      `${command}: ${detail?.error ?? 'error'}: ${String(detail?.message ?? '').slice(0, 800)}`,
    );
    this.name = 'MarionetteError';
    this.command = command;
    this.detail = detail;
  }
}

// Socket errors that mean the server is not accepting yet (as against a protocol failure).
const NOT_READY_CODES = new Set(['ECONNREFUSED', 'ECONNRESET']);

/** The server was not reachable (refused or reset) or closed the socket; a later attempt can work. */
export class ConnectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConnectionError';
  }
}

export class MarionetteClient {
  /** The server's hello message, set once connected. */
  hello = null;
  #socket;
  #parser = new FrameParser();
  #pending = new Map();
  #nextId = 0;
  #closed = null;

  constructor(socket) {
    this.#socket = socket;
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (error) =>
      this.#fail(NOT_READY_CODES.has(error.code) ? new ConnectionError(error.message) : error),
    );
    socket.on('close', () => this.#fail(new ConnectionError('Marionette socket closed')));
  }

  /** Connects and resolves after the server's hello message. */
  static connect({ port, host = '127.0.0.1', timeoutMs = 10_000 }) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host });
      const client = new MarionetteClient(socket);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`no Marionette hello from ${host}:${port} within ${timeoutMs} ms`));
      }, timeoutMs);
      client.#pending.set('hello', {
        resolve: (hello) => {
          clearTimeout(timer);
          client.hello = hello;
          resolve(client);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  #onData(chunk) {
    let messages;
    try {
      messages = this.#parser.push(chunk);
    } catch (error) {
      this.#fail(error);
      this.#socket.destroy();
      return;
    }
    for (const message of messages) {
      if (!Array.isArray(message)) {
        this.#pending.get('hello')?.resolve(message);
        this.#pending.delete('hello');
        continue;
      }
      const [, id, error, result] = message;
      const pending = this.#pending.get(id);
      if (!pending) continue;
      this.#pending.delete(id);
      if (error) pending.reject(new MarionetteError(pending.name, error));
      else pending.resolve(result);
    }
  }

  #fail(error) {
    this.#closed ??= error;
    for (const pending of this.#pending.values()) pending.reject(this.#closed);
    this.#pending.clear();
  }

  /** Sends one command and resolves with its result. */
  command(name, params = {}, { timeoutMs = 30_000 } = {}) {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${name}: no reply within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        name,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.write(encodeMessage([0, id, name, params]));
    });
  }

  /** Opens the session and switches to chrome (launch with MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1). */
  async start({ scriptTimeoutMs = 30_000 } = {}) {
    await this.command('WebDriver:NewSession', { capabilities: { alwaysMatch: {} } });
    await this.command('WebDriver:SetTimeouts', { script: scriptTimeoutMs });
    await this.command('Marionette:SetContext', { value: 'chrome' });
  }

  /**
   * Runs a script body in the selected chrome window and returns its value. The
   * body may return a promise; return JSON-friendly data (objects of other
   * compartments do not serialize reliably).
   */
  async executeScript(script, args = [], options) {
    const result = await this.command('WebDriver:ExecuteScript', { script, args }, options);
    return result?.value;
  }

  /** Quits the application through Marionette; the socket closes as it goes. */
  async quit(flags = ['eForceQuit']) {
    try {
      await this.command('Marionette:Quit', { flags }, { timeoutMs: 10_000 });
    } catch {
      // The server may drop the socket before it replies.
    }
  }

  close() {
    this.#socket.destroy();
  }
}
