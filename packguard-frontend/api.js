/* ============================================================
 * lib/api.ts  (shipped as plain JS for the prototype)
 * ------------------------------------------------------------
 * Typed client for every §4 endpoint. AbortController-based
 * client timeouts (10s resolve, 30s overall flow). Typed
 * ApiError handling.
 *
 *   USE_MOCK = true   →  in-browser simulation (this prototype)
 *   USE_MOCK = false  →  real fetch() to /api/* and the local
 *                        agent at http://127.0.0.1:3939
 *
 * The real-mode functions are written against the exact contract
 * shapes so flipping the flag wires straight into the backend.
 * ============================================================ */
(function () {
  "use strict";

  var USE_MOCK = true;                          // ← flip to false for real backend
  var AGENT = "http://127.0.0.1:3939";          // local loopback agent
  var T_RESOLVE = 10000;                        // §6: abort /api/resolve at 10s
  var T_FLOW = 30000;                           // §6: abort overall flow at 30s
  var D = window.PG_DATA;

  /* ---- ApiError ----------------------------------------------------
   * Carries the contract errorType string + message (+ manualCommand
   * on VSCODE_* failures). `phase` is attached by the caller.        */
  function ApiError(errorType, message, manualCommand) {
    var e = new Error(message || errorType);
    e.name = "ApiError";
    e.errorType = errorType;
    e.message = message || errorType;
    if (manualCommand) e.manualCommand = manualCommand;
    e.isApiError = true;
    return e;
  }

  // wrap an arbitrary thrown thing into an ApiError shape
  function toApiError(err, fallbackType, fallbackMsg) {
    if (err && err.isApiError) return err;
    if (err && err.name === "AbortError") {
      var e = ApiError(fallbackType || "TIMEOUT", fallbackMsg || "Request timed out.");
      e.aborted = true;
      return e;
    }
    return ApiError(fallbackType || "NETWORK", fallbackMsg || (err && err.message) || "Network error.");
  }

  /* ---- fetch with timeout + external abort -------------------------
   * Links an internal timeout controller with the caller's signal so
   * either can cancel the request.                                   */
  function fetchT(url, opts, ms, externalSignal) {
    opts = opts || {};
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms);
    if (externalSignal) {
      if (externalSignal.aborted) ctrl.abort();
      else externalSignal.addEventListener("abort", function () { ctrl.abort(); });
    }
    opts.signal = ctrl.signal;
    return fetch(url, opts)
      .then(function (res) {
        return res.text().then(function (txt) {
          var body = txt ? JSON.parse(txt) : {};
          if (!res.ok) {
            throw ApiError(body.errorType || "HTTP_" + res.status, body.message, body.manualCommand);
          }
          return body;
        });
      })
      .finally(function () { clearTimeout(timer); });
  }

  /* ================================================================
   * MOCK simulation helpers
   * ============================================================== */
  function delay(ms, signal) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(resolve, ms);
      if (signal) signal.addEventListener("abort", function () {
        clearTimeout(t);
        var e = new Error("Aborted"); e.name = "AbortError"; reject(e);
      });
    });
  }
  function isScoped(n) { return /^@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*$/.test(n); }
  function isValidName(n) {
    if (!n || n.length > 214) return false;
    if (n.trim() !== n) return false;
    if (isScoped(n)) return true;
    return /^[a-z0-9-~][a-z0-9-._~]*$/.test(n);
  }

  /* ================================================================
   * §4 — Serverless (same origin)
   * ============================================================== */

  // POST /api/resolve  → ResolvedPackage  (10s timeout)
  function resolvePackage(packageName, signal) {
    if (!USE_MOCK) {
      return fetchT("/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageName: packageName }),
      }, T_RESOLVE, signal).catch(function (e) {
        throw toApiError(e, "REGISTRY_UNAVAILABLE", window.FRAMING.scanningUnavailable);
      });
    }
    // --- mock ---
    return delay(620, signal).then(function () {
      var trig = D.ERROR_TRIGGERS[packageName];
      if (trig === "INVALID_PACKAGE_NAME" || !isValidName(packageName)) {
        throw ApiError("INVALID_PACKAGE_NAME", window.errorCopy("INVALID_PACKAGE_NAME"));
      }
      if (trig === "REGISTRY_UNAVAILABLE") {
        throw ApiError("REGISTRY_UNAVAILABLE", window.errorCopy("REGISTRY_UNAVAILABLE"));
      }
      if (trig === "PACKAGE_UNRESOLVED" || !D.REPORTS[packageName]) {
        throw ApiError("PACKAGE_UNRESOLVED", window.errorCopy("PACKAGE_UNRESOLVED"));
      }
      return D.resolved(packageName);
    });
  }

  // GET /api/scans → GalleryResult
  function getScans(signal) {
    if (!USE_MOCK) {
      return fetchT("/api/scans", { method: "GET" }, T_RESOLVE, signal).catch(function () {
        return { records: [], partial: false, unavailable: true };
      });
    }
    return delay(500, signal).then(function () {
      // To preview other states from the console:
      //   PG_GALLERY_STATE = 'empty' | 'partial' | 'unavailable' | 'ok'
      var mode = window.PG_GALLERY_STATE || "ok";
      if (mode === "empty") return { records: [], partial: false, unavailable: false };
      if (mode === "unavailable") return { records: [], partial: false, unavailable: true };
      return {
        records: D.GALLERY_SEED.slice(),
        partial: mode === "partial",
        unavailable: false,
      };
    });
  }

  /* ================================================================
   * §4 — Local loopback agent (http://127.0.0.1:3939)
   * ============================================================== */

  // GET /local/health → { status:"ok", codeCliAvailable:boolean }
  function getHealth(signal) {
    if (!USE_MOCK) {
      return fetchT(AGENT + "/local/health", { method: "GET" }, 4000, signal)
        .then(function (b) { return { reachable: true, status: b.status, codeCliAvailable: !!b.codeCliAvailable }; })
        .catch(function () { return { reachable: false, status: "down", codeCliAvailable: false }; });
    }
    return delay(700, signal).then(function () {
      // override via PG_AGENT_STATE = 'ok' | 'no-code' | 'down'
      var s = window.PG_AGENT_STATE || "ok";
      if (s === "down") return { reachable: false, status: "down", codeCliAvailable: false };
      return { reachable: true, status: "ok", codeCliAvailable: s !== "no-code" };
    });
  }

  // POST /local/fetch → ScanResultContract  (any FetchErrorType)
  function fetchAndLaunch(resolvedPkg, signal) {
    if (!USE_MOCK) {
      return fetchT(AGENT + "/local/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packageName: resolvedPkg.packageName,
          version: resolvedPkg.version,
          tarballUrl: resolvedPkg.tarballUrl,
          integrity: resolvedPkg.integrity,
        }),
      }, T_FLOW, signal).catch(function (e) {
        throw toApiError(e, "DOWNLOAD_FAILED", window.errorCopy("DOWNLOAD_FAILED"));
      });
    }
    // --- mock ---
    return delay(1500, signal).then(function () {
      var name = resolvedPkg.packageName;
      var trig = D.ERROR_TRIGGERS[name];
      if (trig === "DOWNLOAD_TOO_LARGE") throw ApiError("DOWNLOAD_TOO_LARGE", window.errorCopy("DOWNLOAD_TOO_LARGE"));
      if (trig === "LINK_TARGET_ESCAPE") throw ApiError("LINK_TARGET_ESCAPE", window.errorCopy("LINK_TARGET_ESCAPE"));
      if (trig === "VSCODE_UNAVAILABLE") {
        var cmd = 'code "' + sourcePath(name) + '"';
        throw ApiError("VSCODE_UNAVAILABLE", window.errorCopy("VSCODE_UNAVAILABLE"), cmd);
      }
      return {
        packageName: name,
        version: resolvedPkg.version,
        sourcePath: sourcePath(name),
        reportPath: sourcePath(name) + "/.packguard/report.json",
      };
    });
  }
  function sourcePath(name) {
    var slug = name.replace("/", "-").replace("@", "");
    return "/Users/operator/.packguard/scan-target/" + slug;
  }

  // POST /local/upload → { scanRecord }  (any UploadErrorType)
  function uploadReport(packageName, version, signal) {
    var uploadId = packageName + "@" + version;
    if (!USE_MOCK) {
      return fetchT(AGENT + "/local/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId: uploadId }),
      }, T_FLOW, signal).then(function (b) { return b.scanRecord; })
        .catch(function (e) { throw toApiError(e, "UPLOAD_FAILED", window.errorCopy("UPLOAD_FAILED")); });
    }
    // --- mock ---
    return delay(1700, signal).then(function () {
      if (window.PG_FORCE_REPORT_MISSING) throw ApiError("REPORT_MISSING", window.errorCopy("REPORT_MISSING"));
      return D.recordFor(packageName, { version: version });
    });
  }

  // Load the full normalized ReportSchema from a publicReportUrl (§5.4).
  // In mock mode we resolve from fixtures keyed by package name.
  function getReport(scanRecord, signal) {
    if (!scanRecord || !scanRecord.publicReportUrl) {
      return Promise.resolve(null); // → caller renders from record + "no report" fallback
    }
    if (!USE_MOCK) {
      return fetchT(scanRecord.publicReportUrl, { method: "GET" }, T_RESOLVE, signal)
        .catch(function () { return null; });
    }
    return delay(450, signal).then(function () {
      var r = D.REPORTS[scanRecord.packageName];
      if (!r) return null;
      return {
        packageName: r.packageName,
        version: scanRecord.version || r.version,
        verdict: r.verdict,
        riskScore: r.riskScore,
        findings: r.findings.slice(),
      };
    });
  }

  window.PGApi = {
    USE_MOCK: USE_MOCK,
    T_RESOLVE: T_RESOLVE,
    T_FLOW: T_FLOW,
    ApiError: ApiError,
    resolvePackage: resolvePackage,
    getScans: getScans,
    getHealth: getHealth,
    fetchAndLaunch: fetchAndLaunch,
    uploadReport: uploadReport,
    getReport: getReport,
  };
})();
