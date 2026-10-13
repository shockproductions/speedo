// Portable session packages for moving data between devices. A package carries only the raw
// recorded streams (GNSS, IMU, calibration, settings) plus any track definitions they use; the
// receiving device re-runs the analysis, so packages stay small and always match its version.

export const PACKAGE_FORMAT = "speedo-sessions";
export const PACKAGE_VERSION = 1;
export const PACKAGE_EXTENSION = ".speedo";

const RAW_RUN_KEYS = [
  "id",
  "version",
  "status",
  "date",
  "startedAt",
  "duration",
  "mode",
  "trackId",
  "config",
  "calibration",
  "gnss",
  "imu",
  "samples",
];

export function rawRun(run) {
  const raw = {};
  for (const key of RAW_RUN_KEYS) {
    if (run[key] !== undefined) raw[key] = run[key];
  }
  if (raw.status === "recording") raw.status = "recovered";
  return raw;
}

export function buildPackage(runs, tracks = []) {
  const usedTrackIds = new Set(
    runs.flatMap((run) => [run.trackId, run.analysis?.track?.id]).filter((id) => id && id !== "none"),
  );
  return {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    exportedAt: new Date().toISOString(),
    runs: runs.map(rawRun),
    tracks: tracks.filter((track) => usedTrackIds.has(track.id)),
  };
}

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

async function gunzip(blob) {
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

// Gzipped JSON when the browser supports it (all current ones do), plain JSON otherwise.
export async function encodePackage(pkg) {
  const json = JSON.stringify(pkg);
  if (typeof CompressionStream === "function") {
    return new Blob([await gzip(json)], { type: "application/octet-stream" });
  }
  return new Blob([json], { type: "application/json" });
}

export async function decodePackageBlob(blob) {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const isGzip = head[0] === 0x1f && head[1] === 0x8b;
  if (isGzip && typeof DecompressionStream !== "function") {
    throw new Error("This browser cannot open compressed packages. Update it and try again.");
  }
  const text = isGzip ? await gunzip(blob) : await blob.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Not a Speedo session file.");
  }
}

function looksLikeRun(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.id === "string" &&
      (Array.isArray(value.gnss) || Array.isArray(value.samples)),
  );
}

// Accepts a package, or a single session exported as JSON by older versions.
export function readPackage(data) {
  if (data?.format === PACKAGE_FORMAT) {
    if (data.version > PACKAGE_VERSION) {
      throw new Error("This file comes from a newer Speedo version. Update the app on this device first.");
    }
    return {
      runs: (data.runs ?? []).filter(looksLikeRun).map(rawRun),
      tracks: (data.tracks ?? []).filter((track) => track?.id && track?.startFinish),
    };
  }
  if (looksLikeRun(data)) {
    return { runs: [rawRun(data)], tracks: [] };
  }
  throw new Error("Not a Speedo session file.");
}

export function packageFileName(runs) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const label = runs.length === 1 ? runs[0].mode ?? "session" : `${runs.length}-sessions`;
  return `speedo-${stamp}-${label}${PACKAGE_EXTENSION}`;
}

// Send a package with the system share sheet (phone -> Drive, email, AirDrop, chat), or
// download it where sharing files is not supported (most desktops).
export async function shareOrDownload(blob, fileName) {
  const file = new File([blob], fileName, { type: blob.type || "application/octet-stream" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Speedo sessions" });
      return "shared";
    } catch (error) {
      if (error?.name === "AbortError") return "cancelled";
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  return "downloaded";
}
