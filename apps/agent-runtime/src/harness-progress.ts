// PROGRESS LINES — spec 370 P2, now the package's (spec 433 W1 step 1): `ProgressLineV1`, `progressLine` and `toolWords`
// come from `@agenticprimitives/service-host`; the routes call `runStoreFor(env).appendProgress|readProgress` (the asker lowercased: reading is gated on it).

export type { ProgressLineV1 } from '@agenticprimitives/service-host';
export { toolWords, progressLine } from '@agenticprimitives/service-host';
