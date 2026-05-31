/**
 * Backwards-compatibility shim.
 *
 * The shared contracts were split into focused modules (`scan.ts`,
 * `report.ts`, `errors.ts`) as part of the Person A integration work. The
 * frontend (Person B) and earlier code import these types from
 * `@shared/contracts`, so this module re-exports the split definitions to keep
 * that import path working. Prefer importing from the specific modules
 * (`@shared/scan`, `@shared/report`, `@shared/errors`) in new code.
 */

// Scan_Result_Contract, Scan_Record, Gallery result, resolution & safe-tar models.
export type {
  ScanResultContract,
  ScanRecord,
  GalleryResult,
  ResolvedPackage,
  SafeTarLimits,
} from "./scan.js";
export { DEFAULT_SAFE_TAR_LIMITS } from "./scan.js";

// Report_Schema contract.
export type { Verdict, Severity, Finding, ReportSchema } from "./report.js";

// Error-type contracts.
export { FetchErrorType, UploadErrorType } from "./errors.js";

import { DEFAULT_SAFE_TAR_LIMITS } from "./scan.js";

/**
 * @deprecated Use {@link DEFAULT_SAFE_TAR_LIMITS} from `@shared/scan`.
 * Retained so existing `SAFE_TAR_LIMITS` references keep resolving.
 */
export const SAFE_TAR_LIMITS = DEFAULT_SAFE_TAR_LIMITS;
