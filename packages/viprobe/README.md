# viprobe

Private generic call recording and strict replay for the Terminfo Phase0 unit.
The host owns artifact files, identities and result policy. This package has no terminal or test-runner dependency.

Create an opaque log with `createCallLog()`, then wrap a live object with
`withCallLog(subject, { mode: "record", log })`. Await the work and call the session's
`finish()` before the host serializes the log with `JSON.stringify`.

Load persisted JSON through `readCallLog(unknown)`. Replay uses
`withCallLog<Subject>(null, { mode: "replay", log })`; it never opens the live subject.
Run the selected body against `session.context`, await it and call `finish()`.
Changed, missing, extra or unfinished calls produce `IncompleteReplay`; catching
that error does not make the session complete.

The persisted format is `viprobe.call-log`, version1, with canonical keys.
Private spike A/B artifacts are rejected. The package has no storage API or mutable log fields.
This foundation remains part of an unfinished consumer unit; it is not an independent delivery.
