const LAYER_COLORS = [
  "#2bd1ff",
  "#24e0a4",
  "#ffd166",
  "#ff7f51",
  "#f5f7fa",
  "#00f5d4",
  "#f4a261",
  "#e9c46a",
  "#66e3ff",
  "#8ecae6"
];

export function createId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function pickUniqueColor(usedColors = []) {
  const lowerUsed = new Set(usedColors.map((item) => item.toLowerCase()));
  const next = LAYER_COLORS.find((color) => !lowerUsed.has(color.toLowerCase()));
  if (next) {
    return next;
  }

  let color = "#";
  const chars = "89ABCDEF";
  for (let i = 0; i < 6; i += 1) {
    color += chars[Math.floor(Math.random() * chars.length)];
  }
  return color;
}

export function nextLayerName(layers = []) {
  const exists = new Set(layers.map((layer) => layer.name));
  let index = 1;
  while (exists.has(`路线${index}`)) {
    index += 1;
  }
  return `路线${index}`;
}

export function formatDistance(meters = 0) {
  if (!Number.isFinite(meters)) {
    return "-";
  }
  if (meters < 1000) {
    return `${Math.round(meters)}m`;
  }
  return `${(meters / 1000).toFixed(1)}km`;
}

export function formatDuration(seconds = 0) {
  if (!Number.isFinite(seconds)) {
    return "-";
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.max(1, Math.round((seconds % 3600) / 60));
  if (hours <= 0) {
    return `${mins}分钟`;
  }
  return `${hours}小时${mins}分钟`;
}

export function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

export function compactPointName(name = "") {
  if (name.length <= 14) {
    return name;
  }
  return `${name.slice(0, 14)}...`;
}
