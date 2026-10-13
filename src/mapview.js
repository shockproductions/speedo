let mapInstanceCounter = 0;

// Slow -> fast: deep red, orange, yellow, green.
function speedColor(fraction) {
  const stops = [
    [0, [214, 40, 40]],
    [0.4, [255, 122, 47]],
    [0.7, [255, 211, 108]],
    [1, [92, 214, 120]],
  ];
  const clamped = Math.min(1, Math.max(0, fraction));
  for (let index = 1; index < stops.length; index += 1) {
    const [position, color] = stops[index];
    const [previousPosition, previousColor] = stops[index - 1];
    if (clamped <= position) {
      const local = (clamped - previousPosition) / (position - previousPosition);
      const mixed = color.map((channel, channelIndex) =>
        Math.round(previousColor[channelIndex] + (channel - previousColor[channelIndex]) * local),
      );
      return `rgb(${mixed.join(",")})`;
    }
  }
  return "rgb(92,214,120)";
}

export class MapView {
  constructor(container) {
    this.container = container;
    this.map = null;
    this.cursor = null;
    this.pickHandler = null;
  }

  destroy() {
    this.map?.remove();
    this.map = null;
  }

  // points: [{lat, lon, v}], gates: [{a, b, color, label}]
  render({ points, gates = [], colorBySpeed = true, compact = false }) {
    const valid = points.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
    if (!valid.length) {
      this.container.innerHTML =
        '<div class="details-empty"><p>No GNSS positions were captured for this run.</p></div>';
      return;
    }

    this.destroy();
    const mapId = `trajectoryMap-${(mapInstanceCounter += 1)}`;
    this.container.innerHTML = `<div id="${mapId}" class="map-frame${compact ? " compact-map" : ""}"></div>`;
    this.map = L.map(mapId, { zoomControl: false, attributionControl: true, preferCanvas: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(this.map);

    const latLngs = valid.map((point) => [point.lat, point.lon]);
    if (colorBySpeed && valid.length > 1) {
      const speeds = valid.map((point) => point.v).filter(Number.isFinite);
      const min = Math.min(...speeds);
      const max = Math.max(...speeds);
      for (let index = 1; index < valid.length; index += 1) {
        const speed = (valid[index].v + valid[index - 1].v) / 2;
        L.polyline([latLngs[index - 1], latLngs[index]], {
          color: speedColor(max > min ? (speed - min) / (max - min) : 1),
          weight: 4,
          interactive: false,
        }).addTo(this.map);
      }
    } else {
      L.polyline(latLngs, { color: "#ff7a2f", weight: 4, interactive: false }).addTo(this.map);
    }

    for (const gate of gates) {
      L.polyline(
        [
          [gate.a.lat, gate.a.lon],
          [gate.b.lat, gate.b.lon],
        ],
        { color: gate.color ?? "#ffffff", weight: 5, dashArray: gate.auto ? "6 6" : null },
      )
        .bindTooltip(gate.label ?? "", { permanent: true, direction: "top", className: "gate-label" })
        .addTo(this.map);
    }

    this.cursor = L.circleMarker(latLngs[0], {
      radius: 7,
      color: "#ffffff",
      weight: 2,
      fillColor: "#ff4121",
      fillOpacity: 1,
    }).addTo(this.map);

    this.map.on("click", (event) => {
      this.pickHandler?.({ lat: event.latlng.lat, lon: event.latlng.lng });
    });
    this.map.fitBounds(L.latLngBounds(latLngs), { padding: [18, 18] });
  }

  // Replace the dot cursor with an arrow that shows the direction of travel.
  useHeadingMarker() {
    if (!this.map || !this.cursor) return;
    const position = this.cursor.getLatLng();
    this.cursor.remove();
    this.cursor = L.marker(position, {
      icon: L.divIcon({ className: "heading-marker", html: '<div class="heading-arrow"></div>', iconSize: [28, 28] }),
      interactive: false,
    }).addTo(this.map);
  }

  setCursor(lat, lon, heading = null) {
    if (!this.cursor || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    this.cursor.setLatLng([lat, lon]);
    const arrow = this.cursor.getElement?.()?.querySelector(".heading-arrow");
    if (arrow && Number.isFinite(heading)) arrow.style.transform = `rotate(${heading}deg)`;
  }

  invalidate() {
    this.map?.invalidateSize();
  }

  setPickHandler(handler) {
    this.pickHandler = handler;
    this.container.classList.toggle("map-picking", Boolean(handler));
  }
}
