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
 */
export * from "./config.js";
export * from "./report.js";
export * from "./scan.js";
export * from "./errors.js";
export * from "./package-name.js";
