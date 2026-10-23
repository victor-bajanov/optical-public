// O9.1: the one place confirmable ops are wired in. Each op module calls
// registerConfirmableOp(...) at import time; importing it here guarantees the
// confirm route (which imports this file) can replay it. One import line per
// op, alphabetical. Parallel cards each add a line here, so cherry-picks will
// conflict on this file: resolve by keeping every import line.
//
// import "../handlers/example-confirmable-op";
import "../handlers/booking-page";
import "../handlers/account";
import "../handlers/polls";

export {};
