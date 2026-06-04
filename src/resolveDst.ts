/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Resolve a NMEA 2000 destination address from a SignalK `$source` string.
 *
 * Most providers (canboatjs, ydwg02) produce `$source` strings whose last
 * dot-separated token is the device's current CAN address as a decimal
 * integer (e.g. `canboatjs.31`). For these, the address is taken directly.
 *
 * Some providers (notably canboatjs's `MaretronIPG` and `N2kIpGateway` with
 * `useCanName: true`) attribute by 64-bit NAME instead, producing strings
 * like `Maretron-IPG-192.168.0.179.c03c8c0c1139f548`. The hex tail is not a
 * base-10 integer, so we look up the live address by walking
 * `app.signalk.retrieve().sources[<label>]` — whose entries are keyed by
 * numeric CAN address and carry a `canName` — for the entry whose canName
 * matches the tail, and return its address key.
 *
 * Returns `undefined` when no plausible address can be determined.
 */
export function resolveDstFromSource(
  app: any,
  srcString: string
): number | undefined {
  // A $source is `<label>.<tail>`. The label itself can contain dots (e.g.
  // an IP address: `Maretron-IPG-192.168.0.179`), so split on the LAST dot:
  // everything before it is the source label (the key into `sources`), and
  // the final segment is the tail — either a decimal CAN address or, when the
  // provider uses `useCanName`, the 64-bit NAME (hex).
  const lastDot = srcString.lastIndexOf('.')
  const label = lastDot >= 0 ? srcString.slice(0, lastDot) : srcString
  const tail = lastDot >= 0 ? srcString.slice(lastDot + 1) : srcString

  // Fast path: tail is already a decimal CAN address (0–251 are valid
  // unicast destinations; 254 is null-address; 255 is broadcast).
  if (/^\d+$/.test(tail)) {
    const direct = parseInt(tail, 10)
    if (direct >= 0 && direct < 252) return direct
  }

  // Slow path: tail is a canName (hex NAME). The live sources registry is
  // keyed `sources[<label>][<numeric CAN address>] = { ..., canName }`, so
  // walk that label's entries for the one whose canName matches the tail and
  // return its numeric address key — that is the device's current dst.
  const sources = app?.signalk?.retrieve?.()?.sources?.[label]
  if (!sources || typeof sources !== 'object') return undefined
  for (const [addrStr, entry] of Object.entries(
    sources as Record<string, any>
  )) {
    const canName = entry?.canName ?? entry?.n2k?.canName
    if (canName === tail) {
      const addr = parseInt(addrStr, 10)
      if (!isNaN(addr) && addr >= 0 && addr < 252) return addr
    }
  }
  return undefined
}
