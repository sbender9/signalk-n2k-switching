// Smoke-test the CZone emulator packers against reference payloads.
// Run with: node test/czoneEmulator.test.mjs
import assert from 'node:assert/strict'
import { CZoneEmulator } from '../dist/czoneEmulator.js'

const emitted = []
const mockApp = {
  debug: () => {},
  emit: (event, payload) => emitted.push({ event, payload }),
  on: () => {},
  removeListener: () => {},
  handleMessage: () => {}
}

const emu = new CZoneEmulator(
  mockApp,
  { enabled: true, dipswitchGroup: 0x18, instance: 23, uniqueSerial: 0xdb13b },
  67,
  'signalk-n2k-switching'
)
emu.start()

// The announce frame: PGN 65290, payload should match reference 3B B1 0D 00 00 18
const announce = emitted.find(
  (e) => e.event === 'nmea2000JsonOut' && e.payload.pgn === 65290
)
assert.ok(announce, 'expected PGN 65290 announce frame')
// data = 2-byte BEP header + 6-byte payload
const ann = announce.payload.data
assert.equal(ann.length, 8, 'PGN 65290 total data length')
assert.deepEqual(
  Array.from(ann.slice(2)),
  [0x3b, 0xb1, 0x0d, 0x00, 0x00, 0x18],
  'PGN 65290 payload matches reference capture'
)

// Circuit descriptor: 20 data bytes, header 01 18 ...
const desc = emitted.find(
  (e) => e.event === 'nmea2000JsonOut' && e.payload.pgn === 130817
)
assert.ok(desc, 'expected PGN 130817 descriptor frame')
const d = desc.payload.data
assert.equal(d.length, 22, 'PGN 130817 total data length (2+20)')
assert.equal(d[2], 0x01, 'PGN 130817 byte[0] = 0x01')
assert.equal(d[3], 0x18, 'PGN 130817 byte[1] = dipswitch group')

// Toggle switch 1 and verify 65283 encodes it correctly
emitted.length = 0
emu.setFromSignalK(1, true)
const state = emitted.find(
  (e) => e.event === 'nmea2000JsonOut' && e.payload.pgn === 65283
)
assert.ok(state, 'expected PGN 65283 state frame')
const s = state.payload.data
assert.equal(s[2], 0x18, 'byte[0] = dipswitch group')
assert.equal(s[3], 0x01, 'byte[1] = switch1 on (bits 0-1 = 01)')
assert.equal(s[4], 0x00, 'byte[2] = 0')

// Toggle switch 3 (without switch 1): byte[1] bits 4-5 should be 01 = 0x10
emu.setFromSignalK(1, false)
emitted.length = 0
emu.setFromSignalK(3, true)
const s3 = emitted.find(
  (e) => e.event === 'nmea2000JsonOut' && e.payload.pgn === 65283
)
assert.ok(s3, 'expected PGN 65283 for switch 3')
assert.equal(s3.payload.data[3], 0x10, 'switch3 on encodes to byte[1] = 0x10')

// 127501 emission should contain 28 indicator fields
const status = emitted.find(
  (e) => e.event === 'nmea2000JsonOut' && e.payload.pgn === 127501
)
assert.ok(status, 'expected PGN 127501 status')
assert.equal(status.payload.fields.instance, 23)
assert.equal(status.payload.fields.indicator3, 'On')
assert.equal(status.payload.fields.indicator1, 'Off')

emu.stop()
console.log('czone emulator packer smoke test: PASS')
