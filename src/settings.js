const SETTINGS_KEY = "speedo.settings";
const CALIBRATION_KEY = "speedo.calibration";

export const DEFAULT_SETTINGS = {
  mode: "track",
  sampleRateHz: 20,
  maxDurationSeconds: 0,
  lapMinSeconds: 20,
  units: "kmh",
  voice: true,
  driftTone: false,
  autoStartKmh: 30,
  autoStopSeconds: 60,
  trackSelection: "auto",
  gnssLagMs: 0,
  driveTab: "speed",
};

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    if (value == null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // Storage can be unavailable (private mode); settings then last for this session only.
  }
}

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...(readJson(SETTINGS_KEY) ?? {}) };
}

export function saveSettings(settings) {
  writeJson(SETTINGS_KEY, settings);
}

export function loadCalibration() {
  return readJson(CALIBRATION_KEY);
}

export function saveCalibration(snapshot) {
  writeJson(CALIBRATION_KEY, snapshot);
}

export function speedFactor(units) {
  return units === "mph" ? 0.621371 : 1;
}

export function speedUnit(units) {
  return units === "mph" ? "mph" : "km/h";
}

export function formatSpeed(kmh, units, digits = 0) {
  return Number.isFinite(kmh) ? `${(kmh * speedFactor(units)).toFixed(digits)} ${speedUnit(units)}` : "N/A";
}

export function formatDistance(meters, units) {
  if (!Number.isFinite(meters)) return "N/A";
  return units === "mph" ? `${(meters / 1609.344).toFixed(2)} mi` : `${(meters / 1000).toFixed(2)} km`;
}
