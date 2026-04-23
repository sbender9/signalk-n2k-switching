/* eslint-disable @typescript-eslint/no-explicit-any */
/*
 * Copyright 2017 Scott Bender <scott@scottbender.net>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  PGN_127502,
  PGN_126208_NmeaCommandGroupFunction,
  convertCamelCase
} from '@canboat/ts-pgns'
import { CZoneEmulator, CZoneEmulatorOptions } from './czoneEmulator'
import {
  DEFAULT_DIPSWITCH_GROUP,
  DEFAULT_INSTANCE,
  INDICATOR_COUNT
} from './czoneConstants'

const PLUGIN_ID = 'signalk-n2k-switching'
const PLUGIN_NAME = 'NMEA2000 Switching'
const CZONE_EMULATED_ADDRESS_DEFAULT = 67
const CZONE_UNIQUE_SERIAL_MAX = 0xfffff

module.exports = function (app: any) {
  const plugin: any = {}
  let onStop: any[] = []
  let registeredPaths: string[] = []
  let pluginOptions: any
  let czoneEmulator: CZoneEmulator | undefined

  // Waiters for PGN 126208 Acknowledge responses from Maretron-style switch
  // banks, keyed by device source address (dst of the original command).
  const pendingAcks = new Map<number, Array<() => void>>()

  plugin.id = PLUGIN_ID
  plugin.name = PLUGIN_NAME
  plugin.description = 'SignalK Plugin to enable N2K Switching'

  plugin.schema = {
    title: PLUGIN_NAME,
    type: 'object',
    properties: {
      maretronCompatibility: {
        type: 'boolean',
        title:
          'Maretron Compatibility (Sends command PGN 126208 to update switch status PGN 127501 in addition to the standard switch control PGN 127502)',
        default: false
      },
      czoneEmulation: {
        type: 'object',
        title:
          'CZone emulation (publishes a virtual CZone switch panel to the bus)',
        properties: {
          enabled: { type: 'boolean', default: false },
          dipswitchGroup: {
            type: 'integer',
            title: 'Dipswitch group',
            default: DEFAULT_DIPSWITCH_GROUP,
            minimum: 1,
            maximum: 253
          },
          instance: {
            type: 'integer',
            title: 'Switch bank instance',
            default: DEFAULT_INSTANCE,
            minimum: 0,
            maximum: 252
          },
          address: {
            type: 'integer',
            title: 'Emulated N2K source address',
            default: CZONE_EMULATED_ADDRESS_DEFAULT,
            minimum: 1,
            maximum: 252
          }
        }
      }
    }
  }

  function actionHandler(
    context: string,
    path: string,
    dSource: string | undefined,
    value: any,
    cb: (res: any) => void
  ) {
    if (!dSource) {
      const current = app.getSelfPath(path)
      if (current && current.$source) {
        dSource = current.$source
        app.debug('resolved source from current data: %s', dSource)
      }
    }

    app.debug(`setting ${path} to ${value}`)

    const parts = path.split('.')
    let instance = Number(parts[3])
    let switchNum = Number(parts[4])

    let bankMeta
    let switchMeta

    if (app.getMetadata) {
      bankMeta = app.getMetadata(`vessels.self.${parts.slice(0, 4).join('.')}`)
      switchMeta = app.getMetadata(
        `vessels.self.${parts.slice(0, 5).join('.')}`
      )
    } else {
      bankMeta = app.getSelfPath(parts.slice(0, 4).join('.') + '.meta')
      switchMeta = app.getSelfPath(parts.slice(0, 5).join('.') + '.meta')
    }

    if (bankMeta && bankMeta.instanceNumber !== undefined) {
      instance = bankMeta.instanceNumber
    }

    if (switchMeta && switchMeta.instanceNumber !== undefined) {
      switchNum = switchMeta.instanceNumber
    }

    const source = app.getSelfPath(path)

    const pgn = convertCamelCase(
      app,
      new PGN_127502({
        instance
      })
    )

    const new_int = value === 1 || value === 'on' || value === true ? 1 : 0
    const new_value = new_int === 1 ? 'On' : 'Off'

    const pa: any = pgn as any
    pa.fields[`switch${switchNum}`] = new_value

    app.debug('sending %j', pgn)
    app.emit('nmea2000JsonOut', pgn)

    //maretron switch control uses pgn 126208 command to toggle the state via 127501
    let dst: number | undefined
    if (pluginOptions.maretronCompatibility === true) {
      //the command must be sent to the device, it cannot be sent to the broadcast
      if (source === undefined && dSource) {
        app.debug(
          "%s is undefined, either we didn't ever got a value or getSelfPath isn't working because vessel uuid/mmsi is missing",
          path
        )
        const parts = dSource.split('.')
        dst = parseInt(parts[parts.length - 1])
      } else if (source === undefined) {
        app.debug(
          'skipping Maretron command: %s has no current value or source to determine destination',
          path
        )
      } else {
        const parts = source['$source'].split('.')
        dst = parseInt(parts[parts.length - 1])
      }

      if (dst !== undefined) {
        //the command parameter for the switch number is shifted by one due to the first parameter being the instance
        switchNum++

        const commandPgn = convertCamelCase(
          app,
          new PGN_126208_NmeaCommandGroupFunction(
            {
              pgn: 127501,
              priority: 8,
              numberOfParameters: 2,
              list: [
                {
                  parameter: 1,
                  value: instance
                },
                {
                  parameter: switchNum,
                  value: new_value
                }
              ]
            },
            dst
          )
        )

        setTimeout(function () {
          app.debug('sending command %j', commandPgn)
          app.emit('nmea2000JsonOut', commandPgn)
        }, 1000)
      }
    }

    // Some switch banks (e.g. Maretron) broadcast PGN 127501 periodically
    // rather than on-change, so state confirmation by polling can take
    // 15-30s. Wait up to ~20s before giving up.
    let settled = false
    let ackWaiter: (() => void) | undefined
    const settle = (reply: any) => {
      if (settled) return
      settled = true
      clearInterval(interval)
      if (ackWaiter !== undefined && dst !== undefined) {
        const cur = pendingAcks.get(dst)
        if (cur) {
          const i = cur.indexOf(ackWaiter)
          if (i >= 0) cur.splice(i, 1)
          if (cur.length === 0) pendingAcks.delete(dst)
        }
      }
      cb(reply)
    }

    // When Maretron compatibility is on, the device acknowledges our 126208
    // command PGN within ~500ms via an Acknowledge group function. Short
    // circuit to SUCCESS as soon as that ACK arrives.
    if (pluginOptions.maretronCompatibility === true && dst !== undefined) {
      ackWaiter = () => {
        app.debug('SUCCESS (126208 ACK)')
        settle({ state: 'SUCCESS' })
      }
      const waiters = pendingAcks.get(dst) ?? []
      waiters.push(ackWaiter)
      pendingAcks.set(dst, waiters)
    }

    let retryCount = 0
    const interval = setInterval(() => {
      let val = app.getSelfPath(path)
      app.debug('checking %s %j should be %j', path, val, new_int)
      if (val) {
        val = val.values && dSource ? val.values[dSource]?.value : val.value
      }
      if (val !== undefined && val == new_int) {
        app.debug('SUCCESS')
        settle({ state: 'SUCCESS' })
      } else if (retryCount++ > 19) {
        settle({
          state: 'FAILURE',
          message: 'Did not receive change confirmation'
        })
      }
    }, 1000)

    return { state: 'PENDING' }
  }

  function subscription_error(err: any) {
    app.setProviderError(err)
  }
  /*
    Called when the plugin is started (server is started with plugin enabled
    or the plugin is enabled from ui on a running server).
  */
  plugin.start = function (options: any) {
    pluginOptions = options

    if (options.czoneEmulation?.enabled) {
      const emulationOpts: CZoneEmulatorOptions = {
        enabled: true,
        dipswitchGroup:
          options.czoneEmulation.dipswitchGroup ?? DEFAULT_DIPSWITCH_GROUP,
        instance: options.czoneEmulation.instance ?? DEFAULT_INSTANCE,
        uniqueSerial:
          options.czoneEmulation.uniqueSerial ??
          deriveSerialFromApp(app, CZONE_UNIQUE_SERIAL_MAX)
      }
      const address =
        options.czoneEmulation.address ?? CZONE_EMULATED_ADDRESS_DEFAULT
      czoneEmulator = new CZoneEmulator(app, emulationOpts, address, PLUGIN_ID)
      czoneEmulator.start()
      registerCZonePutHandlers(app, czoneEmulator)
      onStop.push(() => {
        czoneEmulator?.stop()
        czoneEmulator = undefined
      })
    }

    // Listen for PGN 126208 Acknowledge responses from Maretron switch
    // banks so pending PUT requests can confirm in <1s instead of waiting
    // for the next 15s periodic status broadcast.
    const onN2KIn = (pgn: any) => {
      if (
        !pgn ||
        pgn.pgn !== 126208 ||
        pgn.src === undefined ||
        pgn.fields === undefined ||
        pgn.fields.functionCode !== 'Acknowledge' ||
        pgn.fields.pgn !== 127501
      ) {
        return
      }
      const waiters = pendingAcks.get(pgn.src)
      if (!waiters || waiters.length === 0) return
      // Maretron processes commands sequentially, so pair each ACK with
      // the oldest pending waiter for this device rather than resolving
      // all of them at once.
      const waiter = waiters.shift()
      if (waiters.length === 0) pendingAcks.delete(pgn.src)
      if (waiter) waiter()
    }
    app.on('N2KAnalyzerOut', onN2KIn)
    onStop.push(() => app.removeListener('N2KAnalyzerOut', onN2KIn))

    const command = {
      context: 'vessels.self',
      subscribe: [
        {
          path: `electrical.switches.bank.*`,
          period: 1000
        }
      ]
    }

    app.debug('subscribe %j', command)

    app.subscriptionmanager.subscribe(
      command,
      onStop,
      subscription_error,
      (delta: any) => {
        delta.updates.forEach((update: any) => {
          if (update.values) {
            update.values.forEach((value: any) => {
              const path = value.path
              const key = `${path}.${update.$source}`
              if (
                path.endsWith('state') &&
                registeredPaths.indexOf(key) === -1
              ) {
                app.debug(
                  'register action handler for path %s source %s',
                  path,
                  update.$source
                )
                app.registerActionHandler(
                  'vessels.self',
                  path,
                  (context: string, path: string, value: any, cb: any) => {
                    return actionHandler(
                      context,
                      path,
                      update.$source,
                      value,
                      cb
                    )
                  },
                  update.$source
                )
                registeredPaths.push(key)
              }
            })
          }
        })
      }
    )
  }

  /*
    Called when the plugin is disabled on a running server with the plugin enabled.
  */
  plugin.stop = function () {
    app.debug('stop')
    onStop.forEach((f) => f())
    onStop = []
    registeredPaths = []
    pendingAcks.clear()
  }

  return plugin
}

function registerCZonePutHandlers(app: any, emulator: CZoneEmulator): void {
  const instance = emulator.getInstance()
  for (let i = 1; i <= INDICATOR_COUNT; i++) {
    const path = `electrical.switches.bank.${instance}.${i}.state`
    app.registerActionHandler(
      'vessels.self',
      path,
      (_context: string, _path: string, value: any, cb: (r: any) => void) => {
        const on = value === 1 || value === 'on' || value === true
        emulator.setFromSignalK(i, on)
        cb({ state: 'SUCCESS' })
        return { state: 'COMPLETED', statusCode: 200 }
      }
    )
  }
}

function deriveSerialFromApp(app: any, max: number): number {
  const seed =
    app?.selfId ??
    app?.config?.settings?.vesselUuid ??
    app?.config?.settings?.vesselMMSI ??
    'signalk'
  let h = 0
  for (let i = 0; i < String(seed).length; i++) {
    h = (h * 31 + String(seed).charCodeAt(i)) >>> 0
  }
  return h % (max + 1)
}
