/**
 * Whether the browser itself just started, as opposed to bento-tools reloading under a
 * running browser. `noteStartup` is the `runtime.onStartup` listener: Firefox fires that event
 * only for the APP_STARTUP startup reason, shortly after the background page loads. A dev
 * reload (Alt+Shift+R), or an install or update while the browser runs, does not fire it, and
 * then tabs Firefox did not just restore may be loaded and in use. Boot decisions that are only
 * right after a real start ask `browserStarted`, which is false until the event has arrived, so
 * they must run late enough in boot (after the settle wait) for it to have come on a real start.
 * The listener must be registered during the first script run.
 */
export function createBrowserStartup(): { noteStartup: () => void; browserStarted: () => boolean } {
  let started = false;
  return {
    noteStartup: () => {
      started = true;
    },
    browserStarted: () => started,
  };
}
