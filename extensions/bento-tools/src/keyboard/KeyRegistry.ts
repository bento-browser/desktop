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
    // Firefox 126+ passes the active tab of the window the command fired in.
    browser.commands.onCommand.addListener((command, tab?: browser.tabs.Tab) => {
      handleCommand(command, this.#ctx, tab).catch((err) =>
        console.warn('[bento-tools] command failed:', command, err),
      );
    });
  }
}
