// Vite's `?raw` suffix hands a module's SOURCE TEXT to the importer. The
// engine's determinism suite reads its own sources that way (the no-RNG
// check), which is the one place a test needs the text rather than the
// module.
declare module "*?raw" {
  const source: string;
  export default source;
}
