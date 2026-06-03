export const PIPER_BASE_URL = 'http://127.0.0.1:5050';
export const MAX_PROFILES = 5;
export const MAX_FAVORITES = 5;
export const DEFAULT_SHORTCUTS = { read: 'Alt+Shift+R', pause: 'Alt+Shift+D', stop: 'Alt+Shift+E' };

export function fmt(value) {
  return Number.parseFloat(value).toFixed(1);
}

export function uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function defaultProfile() {
  return { id: 'default', name: 'Profile 1', voice: '', rate: 1.0, volume: 1.0 };
}

export function formatVoiceName(filename, empty = '— None —') {
  if (!filename) return empty;
  const base = filename.replace(/\.onnx$/, '');
  const parts = base.split('-');
  if (parts.length >= 3) {
    const name = parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
    const quality = parts[2].charAt(0).toUpperCase() + parts[2].slice(1);
    return `${name} · ${quality}`;
  }
  return base;
}

export function qualityFromFilename(filename) {
  const base = filename.replace(/\.onnx$/, '');
  const parts = base.split('-');
  const tier = parts[parts.length - 1]?.toLowerCase();
  const map = { x_low: 'x_low', low: 'low', medium: 'med', high: 'high' };
  return map[tier] || null;
}

export function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.round(bytes / 1_000)} KB`;
}

export function comboFromEvent(event) {
  const parts = [];
  if (event.altKey) parts.push('Alt');
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  if (!['Alt', 'Control', 'Shift', 'Meta'].includes(event.key)) {
    const keyName =
      event.code.startsWith('Key') ? event.code.slice(3) :
      event.code.startsWith('Digit') ? event.code.slice(5) :
      event.code;
    parts.push(keyName);
  }
  return parts.join('+');
}
