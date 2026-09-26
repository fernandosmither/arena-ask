/**
 * UUIDv7 (time-ordered) generator.
 *
 * claude.ai's chat backend expects message UUIDs that the *client* generates and
 * sends in `turn_message_uuids`. The real client uses v7 (timestamp-prefixed) ids
 * like `019e954f-...`; we match that format so ordering/validation behaves.
 */
export function uuidv7(): string {
  const ts = Date.now();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  // 48-bit big-endian millisecond timestamp
  b[0] = (ts / 2 ** 40) & 0xff;
  b[1] = (ts / 2 ** 32) & 0xff;
  b[2] = (ts / 2 ** 24) & 0xff;
  b[3] = (ts / 2 ** 16) & 0xff;
  b[4] = (ts / 2 ** 8) & 0xff;
  b[5] = ts & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h
    .slice(8, 10)
    .join('')}-${h.slice(10, 16).join('')}`;
}

/** The root/null parent sentinel used by claude.ai for top-level messages. */
export const ROOT_PARENT = '00000000-0000-4000-8000-000000000000';

/** Any RFC 4122-shaped UUID (lowercase or uppercase hex). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
