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

const PLUGIN_ID = 'signalk-n2k-switching'
const PLUGIN_NAME = 'NMEA2000 Switching'

module.exports = function (app: any) {
  const plugin: any = {}
  let onStop: any[] = []
  let registeredPaths: string[] = []
  let pluginOptions: any

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
      }
    }
  }

  function actionHandler(
    context: string,
    path: string,
    dSource: string,
    value: any,
    cb: (res: any) => void
  ) {
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
    if (pluginOptions.maretronCompatibility === true) {
      //the command must be sent to the device, it cannot be sent to the broadcast
      let dst: number
      if (source === undefined) {
        app.debug(
          "%s is undefined, either we didn't ever got a value or getSelfPath isn't working because vessel uuid/mmsi is missing",
          path
        )
        const parts = dSource.split('.')
        dst = parseInt(parts[parts.length - 1])
      } else {
        const parts = source['$source'].split('.')
        dst = parseInt(parts[parts.length - 1])
      }

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

    let retryCount = 0
    const interval = setInterval(() => {
      let val = app.getSelfPath(path)
      app.debug('checking %s %j should be %j', path, val, new_int)
      if (val) {
        val = val.values ? val.values[dSource].value : val.value
      }
      if (val !== undefined && val == new_int) {
        app.debug('SUCCESS')
        cb({ state: 'SUCCESS' })
        clearInterval(interval)
      } else {
        if (retryCount++ > 5) {
          cb({
            state: 'FAILURE',
            message: 'Did not receive change confirmation'
          })
          clearInterval(interval)
        }
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
  }

  return plugin
}
