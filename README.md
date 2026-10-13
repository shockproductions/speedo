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

## How it works: three stages

1. **Setup**: pick the session type (Logger, Track, Drift, Drag), its options, auto-start, and check GNSS/IMU status and calibration.
2. **Drive**: a full-screen in-car view with only what is useful at a glance, on three tabs:
   - **Speed**: big fused speed plus the mode panel (lap clock and predictive delta, drift angle and score, drag timer, or logger totals)
   - **Map**: live position and trail with start/finish lines
   - **G-Forces**: large friction circle with trail and peak markers
   Stopping needs a press-and-hold so a bump cannot end the session.
3. **Analyse**: post-processing of saved sessions:
   - **Overview**: summary, lap table with sectors, drift table, lap timing source
   - **Map**: 2D (speed-coloured line, edit start/finish and sector lines) or 3D (a ribbon whose height and colour follow speed, g or drift angle, optional terrain)
   - **Graphs**: lap A vs lap B overlays by distance with delta trace, friction circle, and a custom graph builder (any channels against time or distance, session or lap)
   - **Replay**: play back at 0.5x to 16x with a heading arrow on the map and live gauges, scrub, or jump to a lap

## Features

**Track days**
- Lap timing from a start/finish line, with crossing times interpolated between GPS fixes
- Saved tracks with sectors, theoretical best and out-lap/in-lap detection; tracks are picked automatically by location
- Automatic start/finish line when no track is saved, plus "Mark Start/Finish Here" while driving
- Live predictive delta against your best lap, spoken lap times
- Arm Auto-Start: starts above a set speed (keeping the previous 5 s), stops after standing still, re-arms for the next session

**Drift days**
- Drift angle from gyro yaw versus GPS course, propagated between fixes with slip kinematics
- Drift detection with angle, duration, speed, transitions and a score; live drift HUD and optional tone

**Drag**
- Live stage/launch detection, 0-100 km/h (or 0-60 mph), 1/8 and 1/4 mile with trap speed

**Sensor fusion**
- An extended Kalman filter fuses GNSS (the slow sensor, often 1 Hz) with vehicle-frame acceleration and gyro yaw rate, so position, speed and course keep updating between fixes and through GNSS dropouts. Its heading is initialised from the first consecutive moving-forward GNSS fixes. Fixes that disagree strongly with the prediction are rejected.
- Live, the filter drives the speed readout and map. After the run, a forward pass plus a Rauch-Tung-Striebel backward smoother produces the 10 Hz trajectory used for maps, graphs, distance and replay.
- While sliding, inputs are rotated into the direction of travel using the drift angle.
- GNSS delivery latency is measured after each session by lining up GPS speed changes with the IMU, and is reused by the live filter.

**IMU alignment**
- Live: the mount angle is captured whenever the car stands still, and the forward axis is solved from GPS while driving
- After the run, the alignment is re-calculated from the whole trajectory: the full mount rotation and accelerometer bias are solved against GNSS-derived accelerations (Wahba's problem, robustly reweighted so sliding corners cannot tilt it), then the forward axis is refined on straight-line intervals. This works even if the car never stopped, and corrects which way is forward.
- Axis handedness and gyro sign are detected from the data, covering iOS's inverted accelerometer sign

**Recording and data**
- Every GNSS fix is logged (the rate cap only applies to IMU samples)
- Sessions are saved in chunks while recording and recovered after a crash or app kill
- Export CSV (10 Hz channels), RaceLogic VBO, GPX and JSON; km/h or mph

## Notes

- GNSS update rates vary by phone and browser. Higher-rate GPS improves sector and delta resolution.
- Browser PWAs cannot reliably guarantee GNSS and motion capture after the page is backgrounded or the phone is locked. Keep the screen on; a wake lock is requested while recording or armed.
- Drift angle accuracy depends on GPS course quality and gyro drift; the gyro heading is re-aligned on every straight. Long continuous drifts with no straight driving (e.g. donuts) will drift by a few degrees.
- Mount the phone rigidly. A loose mount adds vibration and makes the mount-angle capture less accurate.

## Future improvements

- External Bluetooth GPS receivers (10-25 Hz) via Web Bluetooth
- Video overlay export synced to replay
- Pre-downloading map tiles for offline track use
- Live telemetry dashboard and remote viewer
