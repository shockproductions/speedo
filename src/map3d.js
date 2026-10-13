// 3D session view on MapLibre: the driven line becomes a ribbon whose height and colour follow
// a channel (speed, g, drift angle), over OpenStreetMap tiles with optional terrain.

import { makeProjector } from "./geo.js";

const MAPLIBRE_JS = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js";
const MAPLIBRE_CSS = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css";
const TERRAIN_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const RIBBON_WIDTH = 5;
const MAX_SEGMENTS = 2500;

export const CHANNELS_3D = {
  speed: { label: "Speed", value: (row) => row.v, metresPerUnit: 0.6 },
  lat: { label: "Lateral g", value: (row) => (Number.isFinite(row.lat) ? Math.abs(row.lat) : null), metresPerUnit: 80 },
  long: { label: "Longitudinal g", value: (row) => (Number.isFinite(row.lon) ? Math.abs(row.lon) : null), metresPerUnit: 80 },
  beta: { label: "Drift angle", value: (row) => (Number.isFinite(row.beta) ? Math.abs(row.beta) : null), metresPerUnit: 2.5 },
};

let loader = null;
function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  loader ??= new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = MAPLIBRE_CSS;
    document.head.appendChild(css);
    const script = document.createElement("script");
    script.src = MAPLIBRE_JS;
    script.onload = () => resolve(window.maplibregl);
    script.onerror = () => {
      loader = null;
      reject(new Error("Could not load the 3D map library (offline?)."));
    };
    document.head.appendChild(script);
  });
  return loader;
}

function colorFor(fraction) {
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
      return `rgb(${color.map((channel, i) => Math.round(previousColor[i] + (channel - previousColor[i]) * local)).join(",")})`;
    }
  }
  return "rgb(92,214,120)";
}

function ribbonFeatures(rows, channel) {
  const valid = rows.filter((row) => Number.isFinite(row.la) && Number.isFinite(row.lo));
  if (valid.length < 2) return [];
  const step = Math.max(1, Math.ceil(valid.length / MAX_SEGMENTS));
  const sampled = valid.filter((_, index) => index % step === 0);
  const definition = CHANNELS_3D[channel];
  const values = sampled.map(definition.value).filter(Number.isFinite);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const projector = makeProjector({ lat: sampled[0].la, lon: sampled[0].lo });
  const features = [];
  for (let index = 1; index < sampled.length; index += 1) {
    const a = projector.toXY({ lat: sampled[index - 1].la, lon: sampled[index - 1].lo });
    const b = projector.toXY({ lat: sampled[index].la, lon: sampled[index].lo });
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 0.05 || length > 200) continue;
    const nx = (-(b.y - a.y) / length) * (RIBBON_WIDTH / 2);
    const ny = ((b.x - a.x) / length) * (RIBBON_WIDTH / 2);
    const corners = [
      { x: a.x + nx, y: a.y + ny },
      { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny },
      { x: a.x - nx, y: a.y - ny },
    ].map((corner) => {
      const position = projector.toLatLon(corner);
      return [position.lon, position.lat];
    });
    corners.push(corners[0]);
    const value = definition.value(sampled[index]);
    const finite = Number.isFinite(value) ? value : min;
    features.push({
      type: "Feature",
      properties: {
        height: Math.max(1, finite * definition.metresPerUnit),
        color: colorFor(max > min ? (finite - min) / (max - min) : 1),
      },
      geometry: { type: "Polygon", coordinates: [corners] },
    });
  }
  return features;
}

export class Map3D {
  constructor(container) {
    this.container = container;
    this.map = null;
    this.ready = null;
  }

  destroy() {
    this.map?.remove();
    this.map = null;
  }

  async render({ rows, gates = [], channel = "speed", terrain = false }) {
    this.destroy();
    this.container.innerHTML = '<div class="map-frame map3d-frame"><p class="map3d-loading">Loading 3D view...</p></div>';
    const frame = this.container.firstElementChild;
    let maplibregl;
    try {
      maplibregl = await loadMapLibre();
    } catch (error) {
      frame.innerHTML = `<p class="map3d-loading">${error.message}</p>`;
      return;
    }
    frame.innerHTML = "";

    const sources = {
      osm: {
        type: "raster",
        tiles: ["https://a.tile.openstreetmap.org/{z}/{x}/{y}.png", "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      },
    };
    if (terrain) {
      sources.dem = { type: "raster-dem", tiles: [TERRAIN_TILES], tileSize: 256, encoding: "terrarium", maxzoom: 14 };
    }

    const valid = rows.filter((row) => Number.isFinite(row.la));
    const bounds = valid.reduce(
      (box, row) => [
        [Math.min(box[0][0], row.lo), Math.min(box[0][1], row.la)],
        [Math.max(box[1][0], row.lo), Math.max(box[1][1], row.la)],
      ],
      [[Infinity, Infinity], [-Infinity, -Infinity]],
    );

    this.map = new maplibregl.Map({
      container: frame,
      style: {
        version: 8,
        sources,
        layers: [{ id: "osm", type: "raster", source: "osm" }],
        ...(terrain ? { terrain: { source: "dem", exaggeration: 1.5 } } : {}),
      },
      bounds,
      fitBoundsOptions: { padding: 40, pitch: 60, bearing: -20 },
      pitch: 60,
      bearing: -20,
      maxPitch: 80,
      attributionControl: { compact: true },
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

    this.ready = new Promise((resolve) => {
      this.map.on("load", () => {
        const map = this.map;
        map.addSource("ground", {
          type: "geojson",
          data: { type: "Feature", geometry: { type: "LineString", coordinates: valid.map((row) => [row.lo, row.la]) } },
        });
        map.addLayer({ id: "ground-line", type: "line", source: "ground", paint: { "line-color": "#ffffff", "line-width": 2, "line-opacity": 0.7 } });
        map.addSource("ribbon", { type: "geojson", data: { type: "FeatureCollection", features: ribbonFeatures(rows, channel) } });
        map.addLayer({
          id: "ribbon",
          type: "fill-extrusion",
          source: "ribbon",
          paint: {
            "fill-extrusion-color": ["get", "color"],
            "fill-extrusion-height": ["get", "height"],
            "fill-extrusion-base": 0,
            "fill-extrusion-opacity": 0.85,
          },
        });
        map.addSource("gates", {
          type: "geojson",
          data: {
            type: "FeatureCollection",
            features: gates.map((gate) => ({
              type: "Feature",
              properties: { color: gate.color ?? "#ffffff" },
              geometry: { type: "LineString", coordinates: [[gate.a.lon, gate.a.lat], [gate.b.lon, gate.b.lat]] },
            })),
          },
        });
        map.addLayer({ id: "gates", type: "line", source: "gates", paint: { "line-color": ["get", "color"], "line-width": 5 } });
        map.addSource("cursor", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: "cursor",
          type: "circle",
          source: "cursor",
          paint: { "circle-radius": 8, "circle-color": "#ff4121", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
        });
        resolve();
      });
    });
    return this.ready;
  }

  setCursor(lat, lon) {
    const source = this.map?.getSource?.("cursor");
    if (!source || !Number.isFinite(lat)) return;
    source.setData({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: {} });
  }
}
