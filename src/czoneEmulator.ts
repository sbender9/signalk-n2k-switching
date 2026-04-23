/* eslint-disable @typescript-eslint/no-explicit-any */
/*
 * CZone device emulator.
 *
 * When enabled, this module emits the PGN stream that a Navico CZone-compatible
 * switch panel broadcasts on NMEA2000 so that plotters (Zeus, GO series, etc.)
 * will discover and display a virtual 28-switch bank backed by SignalK state.
 *
 * Protocol surface (all BEP Marine manufacturer code = 116):
 *   - PGN 65290  one-shot "CZone announce" with unique serial + dipswitch group
 *   - PGN 130817 one-shot circuit descriptor (20 bytes, empty template by default)
 *   - PGN 65283  periodic dipswitch-state (6 switches worth, 2 bits each)
 *   - PGN 65284  periodic capability bitmap (32 circuits worth)
 *   - PGN 127501 periodic standard 28-indicator Binary Switch Bank Status
 *
 * Inbound:
 *   - PGN 127502 Instance <instance> with dst = our emulated address updates
 *     the internal 28-bit state and triggers an immediate 65283 + 127501 burst.
 */
import {
  BEP_MANUFACTURER_CODE,
  HEARTBEAT_MS,
  INDICATOR_COUNT
} from './czoneConstants'

export interface CZoneEmulatorOptions {
  enabled: boolean
  dipswitchGroup: number
  instance: number
  uniqueSerial: number
}

interface AppLike {
  debug: (...args: any[]) => void
  emit: (event: string, payload: any) => void
  on: (event: string, listener: (...args: any[]) => void) => void
  removeListener: (event: string, listener: (...args: any[]) => void) => void
  handleMessage?: (pluginId: string, delta: any) => void
  getSelfPath?: (path: string) => any
  registerPutHandler?: (
    context: string,
    path: string,
    handler: (...args: any[]) => any
  ) => void
}

type Indicators = boolean[]

function emptyIndicators(): Indicators {
  return new Array(INDICATOR_COUNT).fill(false)
}

function packDipswitchState(
  group: number,
  indicators: Indicators,
  offset: number
): Buffer {
  // Six switches starting at `offset` (0-based), 2 bits each across bytes 3..4
  // of the 6-byte payload. Byte 7 bit 4 is a presence flag (observed = 1).
  const buf = Buffer.alloc(6)
  buf[0] = group & 0xff
  // bits 0-1 of byte[1] = switch[offset+0], bits 2-3 = switch[+1], bits 4-5 = switch[+2]
  let b1 = 0
  for (let i = 0; i < 3; i++) {
    const on = indicators[offset + i] ? 1 : 0
    b1 |= on << (i * 2)
  }
  // bits 6-7 of byte[1] and continuing into byte[2] bits 0-1 for switch[+3..5]
  let b2 = 0
  for (let i = 0; i < 3; i++) {
    const on = indicators[offset + 3 + i] ? 1 : 0
    b2 |= on << (i * 2)
  }
  buf[1] = b1
  buf[2] = b2
  buf[3] = 0
  buf[4] = 0
  buf[5] = 0x10
  return buf
}

function packCapabilityBitmap(
  group: number,
  capability: number,
  configured: Indicators
): Buffer {
  // byte[0]=group, byte[1]=capability byte, byte[2..5] = 32-bit bitmap of
  // which of up to 32 circuits are configured (we use `configured` positions).
  const buf = Buffer.alloc(6)
  buf[0] = group & 0xff
  buf[1] = capability & 0xff
  for (let i = 0; i < 32; i++) {
    if (i < INDICATOR_COUNT && configured[i]) {
      buf[2 + (i >> 3)] |= 1 << (i & 7)
    }
  }
  return buf
}

function packAnnounce(uniqueSerial: number, group: number): Buffer {
  // PGN 65290 payload layout (6 data bytes):
  //   byte[0..1] = serial low 16 bits (little endian)
  //   byte[2]    = low nibble = serial bits 16-19, high nibble = 0
  //   byte[3]    = 0
  //   byte[4]    = 0
  //   byte[5]    = dipswitch group
  const buf = Buffer.alloc(6)
  buf[0] = uniqueSerial & 0xff
  buf[1] = (uniqueSerial >> 8) & 0xff
  buf[2] = (uniqueSerial >> 16) & 0x0f
  buf[3] = 0
  buf[4] = 0
  buf[5] = group & 0xff
  return buf
}

function packCircuitDescriptor(group: number): Buffer {
  // PGN 130817 layout (20 bytes):
  //   byte[0] = capability/type indicator (observed = 0x01)
  //   byte[1] = dipswitch group
  //   bytes 2..19 = 6 circuit slots of 3 bytes each (id, value_low, value_hi_and_flag)
  // We emit an empty template (all zeros after header) which is the same
  // idle payload a fresh CZone module broadcasts before any circuits are
  // configured through the plotter UI.
  const buf = Buffer.alloc(20)
  buf[0] = 0x01
  buf[1] = group & 0xff
  return buf
}

function bepPrefix(): Buffer {
  // Every BEP proprietary PGN starts with a 2-byte header:
  //   bits 0-10   = manufacturer code (116 = BEP Marine)
  //   bits 11-12  = reserved (11b)
  //   bits 13-15  = industry code (4 = Marine)
  // Encoded little-endian: (0b100 << 13) | (0b11 << 11) | 116
  const header = (0b100 << 13) | (0b11 << 11) | BEP_MANUFACTURER_CODE
  const buf = Buffer.alloc(2)
  buf[0] = header & 0xff
  buf[1] = (header >> 8) & 0xff
  return buf
}

function bepFrame(pgn: number, payload: Buffer): any {
  // Build a raw Actisense-JSON frame with forceSrc honored by canbus.sendPGN.
  const data = Buffer.concat([bepPrefix(), payload])
  return {
    pgn,
    prio: 6,
    dst: 255,
    data,
    forceSrc: true
  }
}

export class CZoneEmulator {
  private readonly app: AppLike
  private readonly opts: CZoneEmulatorOptions
  private readonly address: number
  private readonly pluginId: string
  private indicators: Indicators
  private timer?: NodeJS.Timeout
  private messageListener?: (msg: any) => void
  private started = false

  constructor(
    app: AppLike,
    opts: CZoneEmulatorOptions,
    address: number,
    pluginId: string
  ) {
    this.app = app
    this.opts = opts
    this.address = address
    this.pluginId = pluginId
    this.indicators = emptyIndicators()
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.app.debug(
      'czone emulator starting: group=%d instance=%d address=%d serial=%d',
      this.opts.dipswitchGroup,
      this.opts.instance,
      this.address,
      this.opts.uniqueSerial
    )

    this.sendAnnounce()
    this.sendCircuitDescriptor()
    this.publishDeltas()

    this.messageListener = (msg: any) => this.handleIncoming(msg)
    this.app.on('N2KAnalyzerOut', this.messageListener)

    this.timer = setInterval(() => this.tick(), HEARTBEAT_MS)
  }

  /**
   * Apply a state change coming from SignalK (e.g. a plugin that the host
   * server dispatched a PUT to). Returns true if the state actually changed.
   */
  setFromSignalK(switchNum: number, on: boolean): boolean {
    const i = switchNum - 1
    if (i < 0 || i >= INDICATOR_COUNT) return false
    if (this.indicators[i] === on) return false
    this.indicators[i] = on
    this.broadcastState()
    this.publishDeltas()
    return true
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.messageListener) {
      this.app.removeListener('N2KAnalyzerOut', this.messageListener)
      this.messageListener = undefined
    }
  }

  getInstance(): number {
    return this.opts.instance
  }

  private tick(): void {
    this.broadcastState()
  }

  private broadcastState(): void {
    // 65283: three frames cover switches 1-6, 7-12, 13-18; the real device we
    // observed reports only the first group because it only exposes 6 virtual
    // dipswitches. For a 28-indicator panel we emit consecutive 65283 frames
    // so the plotter sees the full range.
    for (let group = 0; group * 6 < INDICATOR_COUNT; group++) {
      const offset = group * 6
      this.sendBep(
        65283,
        packDipswitchState(
          this.opts.dipswitchGroup + group,
          this.indicators,
          offset
        )
      )
    }
    this.sendBep(
      65284,
      packCapabilityBitmap(this.opts.dipswitchGroup, 0x0f, this.indicators)
    )
    this.sendStatusPgn()
  }

  private sendAnnounce(): void {
    this.sendBep(
      65290,
      packAnnounce(this.opts.uniqueSerial, this.opts.dipswitchGroup)
    )
  }

  private sendCircuitDescriptor(): void {
    this.sendBep(130817, packCircuitDescriptor(this.opts.dipswitchGroup))
  }

  private sendBep(pgn: number, payload: Buffer): void {
    const frame = bepFrame(pgn, payload)
    frame.src = this.address
    this.app.emit('nmea2000JsonOut', frame)
  }

  private sendStatusPgn(): void {
    const fields: any = { instance: this.opts.instance }
    for (let i = 0; i < INDICATOR_COUNT; i++) {
      fields[`indicator${i + 1}`] = this.indicators[i] ? 'On' : 'Off'
    }
    this.app.emit('nmea2000JsonOut', {
      pgn: 127501,
      prio: 3,
      dst: 255,
      src: this.address,
      forceSrc: true,
      fields
    })
  }

  private handleIncoming(msg: any): void {
    if (!msg) return
    if (msg.pgn !== 127502) return
    if (msg.dst !== 255 && msg.dst !== this.address) return
    if (!msg.fields || msg.fields.instance !== this.opts.instance) return

    let changed = false
    for (let i = 0; i < INDICATOR_COUNT; i++) {
      const v = msg.fields[`switch${i + 1}`]
      if (v === 'On' || v === 1 || v === true) {
        if (!this.indicators[i]) {
          this.indicators[i] = true
          changed = true
        }
      } else if (v === 'Off' || v === 0 || v === false) {
        if (this.indicators[i]) {
          this.indicators[i] = false
          changed = true
        }
      }
    }
    if (changed) {
      this.app.debug('czone emulator applied 127502 from src=%d', msg.src)
      this.broadcastState()
      this.publishDeltas()
    }
  }

  private publishDeltas(): void {
    if (!this.app.handleMessage) return
    const values = this.indicators.map((on, i) => ({
      path: `electrical.switches.bank.${this.opts.instance}.${i + 1}.state`,
      value: on ? 1 : 0
    }))
    this.app.handleMessage(this.pluginId, {
      updates: [
        {
          source: {
            label: this.pluginId,
            type: 'NMEA2000',
            src: String(this.address)
          },
          values
        }
      ]
    })
  }
}
