# Telemetry Tracker

Speedo is a client-side mobile telemetry PWA for track days, drift days and drag runs. It records GNSS, accelerometer and gyroscope data, times laps, scores drifts and analyses sessions entirely on the phone.

## Run locally

Because the app uses service workers, geolocation, and motion sensors, serve it over HTTP on a local network or HTTPS.

Examples:

```powershell
npx serve .
```

or

```powershell
python -m http.server 8080
```

Then open the site in a modern mobile browser, ideally Android Chrome, and grant location and motion permissions.

## Features

**Track days**
- Lap timing from a start/finish line, with crossing times interpolated between GPS fixes (about 10-50 ms accuracy even on 1 Hz phone GPS)
- Saved tracks with sectors, theoretical best, out-lap/in-lap detection; tracks are picked automatically by location
- No track saved? A start/finish line is placed automatically 20 s after you first get up to speed; save it as a track afterwards
- "Mark Start/Finish Here" button for setting the line while driving
- Live lap clock, last/best lap and predictive delta against your best lap (session or all-time for the track)
- Spoken lap times and vibration on each lap
- Arm Auto-Start: recording starts above a set speed (keeping the previous 5 s), stops after standing still, and re-arms for the next session

**Drift days**
- Drift angle from gyro yaw versus GPS course, propagated between fixes with slip kinematics
- Automatic drift detection with angle, duration, speed, transitions and a score (angle x speed x time, +10% per transition)
- Live drift HUD and optional pitch-follows-angle tone

**Analysis**
- Speed, g-force and drift-angle overlays by distance, lap A vs lap B with a delta-time trace
- Friction circle (g-g), speed-coloured map with gate lines, chart-to-map cursor
- Sessions grouped by day; drag metrics (0-100 km/h, 1/4 mile) from a standing start

**Calibration**
- The mount angle is captured automatically whenever the car stands still (or on demand)
- The forward axis is solved from GPS while driving by matching IMU accelerations to GPS-derived longitudinal and lateral acceleration; only straight-line intervals set the angle, so drifting does not bias it
- Axis handedness and gyro sign are detected from the data, which covers iOS's inverted accelerometer sign
- Calibration is saved across reloads and invalidated automatically if the mount moves
- Sessions are re-processed with the final calibration, so data recorded before the solve converged is still correct

**Recording and data**
- Every GNSS fix is logged (the rate cap only applies to IMU samples); fix timestamps are aligned to the motion clock
- Sessions are saved in chunks while recording and recovered after a crash or app kill
- Export CSV (10 Hz channels), RaceLogic VBO, GPX and JSON
- km/h or mph

## Notes

- GNSS update rates vary by phone and browser. Higher-rate GPS improves sector and delta resolution.
- Browser PWAs cannot reliably guarantee GNSS and motion capture after the page is backgrounded or the phone is locked. Keep the screen on; a wake lock is requested while recording or armed.
- Drift angle accuracy depends on GPS course quality and gyro drift; the gyro heading is re-aligned on every straight. Long continuous drifts with no straight driving (e.g. donuts) will drift by a few degrees.
- Mount the phone rigidly. A loose mount adds vibration and makes the mount-angle capture less accurate.

## Future improvements

- External Bluetooth GPS receivers (10-25 Hz) via Web Bluetooth
- Pre-downloading map tiles for offline track use
- Video overlay sync markers
- Live telemetry dashboard and remote viewer
