import { escapeHtml } from "./analysisview.js";
import { haversineMeters } from "./geo.js";
import { gateFromEndpoints, isGateFlipped } from "./laptiming.js";

const MIN_GATE_METERS = 5;
const MAX_GATE_METERS = 150;
const OSM_TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const SATELLITE_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

function sameGeometry(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// Draw a track before driving it: tap both edges of the track for the start/finish line and
// for each sector line, flip directions with the arrows, drag the ends to fine-tune, save.
export class TrackEditor {
  constructor(container, { getPosition, onSave, onClose }) {
    this.container = container;
    this.getPosition = getPosition;
    this.onSave = onSave;
    this.onClose = onClose;
    this.map = null;
  }

  isOpen() {
    return Boolean(this.map);
  }

  open(track = null) {
    this.close();
    this.original = track;
    // Lines are kept as endpoints plus direction so they can be dragged and flipped.
    const toLine = (gate) => ({ a: gate.a, b: gate.b, flipped: isGateFlipped(gate) });
    this.lines = {
      startFinish: track?.startFinish ? toLine(track.startFinish) : null,
      sectors: (track?.sectors ?? []).map(toLine),
    };
    this.tool = track?.startFinish ? null : "sf";
    this.pending = null;

    this.container.hidden = false;
    this.container.innerHTML = `
      <div class="track-editor-head">
        <label class="field"><span>Track name</span>
          <input data-te="name" maxlength="60" placeholder="e.g. Spa-Francorchamps" value="${escapeHtml(track?.name ?? "")}" />
        </label>
      </div>
      <div class="detail-actions">
        <button type="button" class="secondary-button" data-te="tool-sf">Set Start/Finish</button>
        <button type="button" class="secondary-button" data-te="tool-sector">Add Sector</button>
        <button type="button" class="secondary-button" data-te="undo-sector">Remove Last Sector</button>
        <button type="button" class="secondary-button" data-te="flip">Flip Direction</button>
      </div>
      <p class="pick-hint" data-te="hint"></p>
      <div class="track-editor-map-wrap">
        <div class="map-frame track-editor-map" data-te="map"></div>
        <div class="track-editor-map-controls">
          <button type="button" class="secondary-button utility-button" data-te="layer">Satellite</button>
          <button type="button" class="secondary-button utility-button" data-te="locate">My Location</button>
        </div>
      </div>
      <p class="panel-note">
        Tap one edge of the track, then the other. The arrow shows the direction of travel: tap
        it (or Flip Direction) to reverse. Drag the line ends to fine-tune. Add sectors in
        driving order.
      </p>
      <div class="actions">
        <button type="button" class="primary-button" data-te="save">Save Track</button>
        <button type="button" class="secondary-button grow-button" data-te="cancel">Cancel</button>
      </div>`;

    const $ = (name) => this.container.querySelector(`[data-te="${name}"]`);
    this.el = { name: $("name"), hint: $("hint"), layer: $("layer") };

    this.map = L.map($("map"), { zoomControl: true, attributionControl: true });
    this.baseLayers = {
      map: L.tileLayer(OSM_TILES, { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }),
      satellite: L.tileLayer(SATELLITE_TILES, {
        maxZoom: 19,
        attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
      }),
    };
    this.layerName = "satellite";
    this.baseLayers.satellite.addTo(this.map);
    this.el.layer.textContent = "Map";
    this.drawLayer = L.layerGroup().addTo(this.map);
    this.map.on("click", (event) => this.handleClick({ lat: event.latlng.lat, lon: event.latlng.lng }));

    const center = track?.startFinish?.center ?? this.getPosition();
    if (center) this.map.setView([center.lat, center.lon], 17);
    else this.map.setView([30, 0], 2);
    window.setTimeout(() => this.map?.invalidateSize(), 50);

    $("tool-sf").addEventListener("click", () => this.setTool("sf"));
    $("tool-sector").addEventListener("click", () => this.setTool("sector"));
    $("undo-sector").addEventListener("click", () => {
      this.lines.sectors.pop();
      this.redraw();
    });
    $("flip").addEventListener("click", () => {
      // Flipping the start/finish usually means the whole track runs the other way.
      for (const line of [this.lines.startFinish, ...this.lines.sectors]) {
        if (line) line.flipped = !line.flipped;
      }
      this.redraw();
    });
    this.el.layer.addEventListener("click", () => this.toggleLayer());
    $("locate").addEventListener("click", () => {
      const position = this.getPosition();
      if (position) this.map.setView([position.lat, position.lon], 17);
      else this.setHint("No GPS position yet. Pan and zoom to the track instead.");
    });
    $("save").addEventListener("click", () => this.save());
    $("cancel").addEventListener("click", () => this.close());
    this.redraw();
    this.container.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  close() {
    this.map?.remove();
    this.map = null;
    if (this.container.innerHTML) {
      this.container.innerHTML = "";
      this.container.hidden = true;
      this.onClose?.();
    }
  }

  toggleLayer() {
    this.baseLayers[this.layerName].remove();
    this.layerName = this.layerName === "satellite" ? "map" : "satellite";
    this.baseLayers[this.layerName].addTo(this.map);
    this.el.layer.textContent = this.layerName === "satellite" ? "Map" : "Satellite";
  }

  setTool(tool) {
    this.tool = tool;
    this.pending = null;
    this.redraw();
  }

  setHint(text) {
    this.el.hint.textContent = text;
    this.el.hint.hidden = !text;
  }

  handleClick(position) {
    if (!this.tool) return;
    if (!this.pending) {
      this.pending = position;
      this.redraw();
      return;
    }
    const length = haversineMeters(this.pending, position);
    if (length < MIN_GATE_METERS || length > MAX_GATE_METERS) {
      this.pending = null;
      this.redraw();
      this.setHint(`That line is ${Math.round(length)} m long. Tap the two edges of the track (${MIN_GATE_METERS}-${MAX_GATE_METERS} m apart).`);
      return;
    }
    const line = { a: this.pending, b: position, flipped: false };
    if (this.tool === "sf") {
      this.lines.startFinish = line;
    } else {
      this.lines.sectors.push(line);
    }
    this.pending = null;
    this.tool = null;
    this.redraw();
  }

  redraw() {
    if (!this.map) return;
    this.drawLayer.clearLayers();
    const all = [
      ...(this.lines.startFinish ? [{ line: this.lines.startFinish, label: "S/F", color: "#ffffff" }] : []),
      ...this.lines.sectors.map((line, index) => ({ line, label: `S${index + 1}`, color: "#c792ea" })),
    ];
    for (const { line, label, color } of all) this.drawLine(line, label, color);

    if (this.pending) {
      L.circleMarker([this.pending.lat, this.pending.lon], {
        radius: 7,
        color: "#ffffff",
        fillColor: "#ff7a2f",
        fillOpacity: 1,
      }).addTo(this.drawLayer);
    }

    const what = this.tool === "sf" ? "start/finish line" : this.tool === "sector" ? `sector line S${this.lines.sectors.length + 1}` : null;
    if (what) {
      this.setHint(this.pending ? `Now tap the other edge of the track for the ${what}.` : `Tap one edge of the track for the ${what}.`);
    } else if (!this.lines.startFinish) {
      this.setHint("Start with Set Start/Finish.");
    } else {
      this.setHint("");
    }
  }

  drawLine(line, label, color) {
    const gate = gateFromEndpoints(line.a, line.b, line.flipped);
    L.polyline([[line.a.lat, line.a.lon], [line.b.lat, line.b.lon]], { color, weight: 6, interactive: false })
      .bindTooltip(label, { permanent: true, direction: "top", className: "gate-label", offset: [0, -14] })
      .addTo(this.drawLayer);

    const arrow = L.marker([gate.center.lat, gate.center.lon], {
      icon: L.divIcon({
        className: "heading-marker",
        html: `<div class="heading-arrow gate-arrow" style="transform: rotate(${gate.heading}deg)"></div>`,
        iconSize: [28, 28],
      }),
      title: "Tap to reverse direction",
    }).addTo(this.drawLayer);
    arrow.on("click", (event) => {
      L.DomEvent.stopPropagation(event);
      line.flipped = !line.flipped;
      this.redraw();
    });

    for (const end of ["a", "b"]) {
      const handle = L.marker([line[end].lat, line[end].lon], {
        draggable: true,
        icon: L.divIcon({ className: "gate-handle", iconSize: [18, 18] }),
      }).addTo(this.drawLayer);
      handle.on("dragend", () => {
        const position = handle.getLatLng();
        line[end] = { lat: position.lat, lon: position.lng };
        this.redraw();
      });
    }
  }

  save() {
    const name = this.el.name.value.trim();
    if (!name) {
      this.setHint("Give the track a name.");
      this.el.name.focus();
      return;
    }
    if (!this.lines.startFinish) {
      this.setHint("Set the start/finish line first.");
      return;
    }
    const toGate = (line) => gateFromEndpoints(line.a, line.b, line.flipped);
    const startFinish = toGate(this.lines.startFinish);
    const sectors = this.lines.sectors.map(toGate);
    const original = this.original;
    // A changed line invalidates the stored best lap (its trace no longer starts on the line).
    const geometryChanged =
      !original || !sameGeometry(original.startFinish, startFinish) || !sameGeometry(original.sectors, sectors);
    const track = {
      id: original?.id ?? `track-${Date.now()}`,
      name,
      startFinish,
      sectors,
      bestLap: geometryChanged ? null : original.bestLap ?? null,
      createdAt: original?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.onSave?.(track, { isNew: !original, geometryChanged });
    this.close();
  }
}
