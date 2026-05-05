// Registers a single browser.commands.onCommand listener and routes incoming
// commands through the static bindings table. Kept thin so future dynamic
// commands (e.g. user-rebound shortcuts) can extend the bindings module
// without touching this listener glue.

import { handleCommand, type BindingContext } from './bindings';

export class KeyRegistry {
  #ctx: BindingContext;

  constructor(ctx: BindingContext) {
    this.#ctx = ctx;
  }

  init(): void {
    browser.commands.onCommand.addListener((command) => {
      handleCommand(command, this.#ctx);
    });
  }
}
