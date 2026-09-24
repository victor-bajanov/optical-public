// Vite `?raw` imports resolve .ics fixtures to their string contents at build
// time, the same mechanism test/setup.ts uses for the migration .sql files.
// Fixtures live in test/booking/fixtures/ and are the inputs to the
// parseIcsBusy corpus tests.
declare module "*.ics?raw" {
  const content: string;
  export default content;
}
