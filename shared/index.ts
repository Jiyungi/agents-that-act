/**
 * Shared module barrel.
 *
 * Re-exports cross-workstream config and the shared contract types defined in
 * task 1.2 (`ScanResultContract`, `ReportSchema`, `ScanRecord`, `GalleryResult`,
 * `ResolvedPackage`, `SafeTarLimits`, `FetchErrorType`, `UploadErrorType`, ...).
 */
export * from "./config.js";
export * from "./contracts.js";
export * from "./framing.js";
