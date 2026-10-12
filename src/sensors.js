const DEG_TO_RAD = Math.PI / 180;

// GNSS fix timestamps come from a different clock than motion events. Map them onto the
// monotonic page clock using the smallest observed delivery latency, which keeps the precise
// fix time while making both streams comparable.
class ClockAligner {
  constructor() {
    this.offset = null;
  }

  align(fixTime, arrival) {
    if (!Number.isFinite(fixTime)) {
      return arrival;
    }
    const offset = arrival - fixTime;
    if (this.offset == null || offset < this.offset) {
      this.offset = offset;
    }
    return fixTime + this.offset;
  }
}

export class SensorManager {
  constructor({ onLocation, onMotion, onStatus }) {
    this.clock = new ClockAligner();
    this.onLocation = onLocation;
    this.onMotion = onMotion;
    this.onStatus = onStatus;
    this.geoWatchId = null;
    this.motionActive = false;
    this.handleMotion = this.handleMotion.bind(this);
    this.motionPermissionGranted = false;
  }

  async requestPermissions({ location = true, motion = true } = {}) {
    const issues = [];

    if (location && !("geolocation" in navigator)) {
      issues.push("Geolocation is not available in this browser.");
    }

    if (motion) {
      if (typeof DeviceMotionEvent === "undefined") {
        issues.push("Motion sensors are not available in this browser.");
      } else if (typeof DeviceMotionEvent.requestPermission === "function") {
        try {
          const result = await DeviceMotionEvent.requestPermission();
          this.motionPermissionGranted = result === "granted";
          if (!this.motionPermissionGranted) {
            issues.push("Motion sensor permission was declined.");
          }
        } catch (error) {
          issues.push("Motion sensor permission was declined.");
        }
      } else {
        this.motionPermissionGranted = true;
      }
    }

    return {
      ok: issues.length === 0,
      issues,
    };
  }

  setStreams({ location = false, motion = false } = {}) {
    if (location && this.geoWatchId == null && "geolocation" in navigator) {
      // Browsers choose the actual GNSS cadence, so we subscribe continuously and timestamp each update.
      this.geoWatchId = navigator.geolocation.watchPosition(
        (position) => {
          const coords = position.coords;
          const arrival = performance.timeOrigin + performance.now();
          this.onStatus?.("location", "Live");
          this.onLocation?.({
            t: this.clock.align(position.timestamp, arrival),
            arrival,
            fixTime: position.timestamp,
            lat: coords.latitude,
            lon: coords.longitude,
            altitude: coords.altitude,
            speed: coords.speed,
            heading: coords.heading,
            accuracy: coords.accuracy,
          });
        },
        (error) => {
          this.onStatus?.("location", "Error");
          this.onStatus?.(
            "permission",
            `Location error: ${error.message || "permission denied or unavailable."}`,
          );
        },
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 10000,
        },
      );
    }

    if (!location && this.geoWatchId != null) {
      navigator.geolocation.clearWatch(this.geoWatchId);
      this.geoWatchId = null;
      this.onStatus?.("location", "Idle");
    }

    if (motion && !this.motionActive && this.motionPermissionGranted) {
      window.addEventListener("devicemotion", this.handleMotion);
      this.motionActive = true;
      this.onStatus?.("motion", "Live");
    }

    if (!motion && this.motionActive) {
      window.removeEventListener("devicemotion", this.handleMotion);
      this.motionActive = false;
      this.onStatus?.("motion", "Idle");
    }
  }

  stopAll() {
    this.setStreams({ location: false, motion: false });
  }

  handleMotion(event) {
    const absolute = event.accelerationIncludingGravity;
    const linear = event.acceleration;
    const rotation = event.rotationRate;
    if (!absolute && !linear) {
      return;
    }
    const hasRotation =
      rotation && Number.isFinite(rotation.alpha) && Number.isFinite(rotation.beta) && Number.isFinite(rotation.gamma);
    this.onStatus?.("motion", "Live");
    this.onMotion?.({
      timestamp: performance.timeOrigin + performance.now(),
      accelX: absolute?.x ?? linear?.x ?? null,
      accelY: absolute?.y ?? linear?.y ?? null,
      accelZ: absolute?.z ?? linear?.z ?? null,
      rawAccelX: absolute?.x ?? null,
      rawAccelY: absolute?.y ?? null,
      rawAccelZ: absolute?.z ?? null,
      linearAccelX: linear?.x ?? null,
      linearAccelY: linear?.y ?? null,
      linearAccelZ: linear?.z ?? null,
      // rotationRate is deg/s: beta about X, gamma about Y, alpha about Z.
      gyroX: hasRotation ? rotation.beta * DEG_TO_RAD : null,
      gyroY: hasRotation ? rotation.gamma * DEG_TO_RAD : null,
      gyroZ: hasRotation ? rotation.alpha * DEG_TO_RAD : null,
      interval: event.interval,
      hasAbsoluteAcceleration: Boolean(absolute),
    });
  }
}
