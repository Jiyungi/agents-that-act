/**
 * Shared barrel for cross-workstream modules.
 *
 * Holds the integration seams Person A and Person B build against:
 *  - config loader (CONFIG_DEFAULTS, loadConfig, PackGuardConfig)
 *  - Report_Schema contract (Verdict, Severity, Finding, ReportSchema)
 *  - scan contracts (ScanResultContract, ScanRecord, GalleryResult,
 *    ResolvedPackage, SafeTarLimits, DEFAULT_SAFE_TAR_LIMITS)
 *  - error-type contracts (FetchErrorType, UploadErrorType)
 *  - package-name validation + safe-key encode/decode (validatePackageName,
 *    encodePackageName, decodePackageName)
 *  - framing copy + forbidden-term guards (Person B frontend)
 *
 * NOTE: `contracts.ts` is intentionally NOT re-exported here. It is kept as a
 * thin backwards-compatibility shim (re-exporting the split modules below) so
 * the frontend's `@shared/contracts` imports keep resolving; re-exporting it
 * from the barrel too would create duplicate-export conflicts.
 */
export * from "./config.js";
export * from "./report.js";
export * from "./scan.js";
export * from "./errors.js";
export * from "./package-name.js";
export * from "./framing.js";
