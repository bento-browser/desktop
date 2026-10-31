// Vite's `?raw` import: the file's text. Used by tests that run an experiment script.
declare module '*?raw' {
  const source: string;
  export default source;
}
