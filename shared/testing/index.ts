/**
 * Barrel for shared test doubles and fixtures (task 1.3).
 *
 * Kept in a dedicated `shared/testing` subpath — NOT re-exported from the
 * production `shared/index.ts` barrel — so test fakes never leak into
 * production bundles. Import from `@shared/testing` (or
 * `@shared/testing/<module>.js`) in tests and integration stubs only.
 *
 * Contents:
 *  - storage-fake: in-memory `StorageService` (Interface 4) + key helpers
 *  - agent-fake:   sample Local_Fetcher_Agent fetch/upload response factories
 *  - fixtures:     normalized Report_Schema + raw-Opsera-output fixtures
 *                  (well-formed and malformed)
 *
 * The real cross-person wiring that removes these doubles is task 17.1.
 */
export * from "./storage-fake.js";
export * from "./agent-fake.js";
export * from "./fixtures.js";
