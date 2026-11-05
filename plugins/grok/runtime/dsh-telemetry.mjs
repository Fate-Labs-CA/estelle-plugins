// Reads what dsh will actually mount, from the text of `dsh --profile <name> --dump-config`, and answers one question:
// is any harness telemetry row on? A later patch layer can undo ours, so the plugin's own file is not evidence.
export const TELEMETRY_ROWS = Object.freeze(['session-log-deepseek', 'session-telemetry-otel', 'plugin-package-inventory-deepseek']);
// Only the web profile mounts this one, so its absence from another profile's dump is not a failure. Present, it must be off.
export const WEB_ONLY_TELEMETRY_ROWS = Object.freeze(['desktop-product-telemetry']);
export const TELEMETRY_OFF = 'DSH-TELEMETRY-OFF';
const MAX_DUMP_BYTES = 8_000_000;
const MAX_ROW_LINES = 64;

/** The rows that are on or absent from the dump. Absent is not off: it is a dump this reader could not read. */
export function telemetryViolations(dump) {
  if (typeof dump !== 'string' || !dump.trim() || dump.length > MAX_DUMP_BYTES) return [...TELEMETRY_ROWS];
  const lines = dump.split('\n');
  return [...TELEMETRY_ROWS, ...WEB_ONLY_TELEMETRY_ROWS].filter(id => {
    const start = lines.findIndex(line => new RegExp(`^(\\s*)- id: ['"]?${id}['"]?\\s*(#.*)?$`).test(line));
    if (start < 0) return !WEB_ONLY_TELEMETRY_ROWS.includes(id);
    const indent = /^\s*/.exec(lines[start])[0].length;
    const row = [];
    for (let at = start + 1; at < lines.length && row.length < MAX_ROW_LINES; at++) {
      const line = lines[at];
      if (line.trim() && !line.trim().startsWith('#') && /^\s*/.exec(line)[0].length <= indent) break;
      row.push(line);
    }
    return !row.some(line => /^\s*disabled:\s*true\s*(#.*)?$/.test(line));
  });
}

export function telemetryCheck(dump) {
  const violations = telemetryViolations(dump);
  return violations.length ? `DSH-TELEMETRY-ON: ${violations.join(',')}` : TELEMETRY_OFF;
}
