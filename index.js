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


const PLUGIN_ID = 'signalk-n2k-switching'
const PLUGIN_NAME = 'NMEA2000 Switching'
const _ = require('lodash')

module.exports = function (app) {
  const plugin = {}
  let onStop = []
  let registeredPaths = []

  plugin.id = PLUGIN_ID
  plugin.name = PLUGIN_NAME
  plugin.description = 'SignalK Plugin to enable N2K Switching'

  plugin.schema = {
    title: PLUGIN_NAME,
    type: 'object',
    properties: {
    }
  }

  function handleMessage (delta) {
    app.handleMessage(PLUGIN_ID, delta)
  }

  function setValueCallback (msg) {
    //dbusSetValue(msg.destination, msg.path, msg.value)
  }

  function actionHandler(context, path, value, cb) {
    app.debug(`setting ${path} to ${value}`)

    const parts = path.split('.')
    const instance = Number(parts[3])
    const switchNum = Number(parts[4])

    const source = app.getSelfPath(path)
    const dst = 255 //169 //source['$source']
    
    app.debug(JSON.stringify(source))

    const pgn = {
      pgn: 127502,
      dst: dst,
      "Switch Bank Instance": instance
    }

    pgn[`Switch${switchNum}`] = value === 1 || value === 'on' ? 'On' : 'Off'
    console.log(JSON.stringify(pgn))
    app.emit('nmea2000JsonOut', pgn)
    //app.emit('nmea2000out', '2019-04-03T23:40:51.859Z,3,127502,0,169,8,00,10,ff,ff,ff,ff,ff,ff')
    
    setTimeout(() => {
      var val = app.getSelfPath(path)
      if ( val && val.value == value ) {
        cb({ state: 'SUCCESS' })
      } else {
        cb({
          state: 'FAILURE',
          message: 'Did not receive change confirmation'
        })
      }
    }, 1000)
    
    return { state: 'PENDING' }
  }

  function subscription_error(err)
  {
    app.setProviderError(err)
  }
  /*
    Called when the plugin is started (server is started with plugin enabled
    or the plugin is enabled from ui on a running server).
  */
  plugin.start = function (options) {
    let command = {
      context: "vessels.self",
      subscribe: [{
        path: `electrical.switches.bank.*`,
        period: 1000
      }]
    }

    app.debug('subscribe %j', command)
    
    app.subscriptionmanager.subscribe(command, onStop, subscription_error, delta => {
      delta.updates.forEach(update => {
        update.values.forEach(value => {
          const path = value.path
          if ( path.endsWith('state') && registeredPaths.indexOf(path) === -1 ) {
            app.debug('register action handler for path %s', path)
            app.registerActionHandler('vessels.self',
                                      path,
                                      actionHandler)
            registeredPaths.push(path)
          }
        })
      })
    })
  }

  /*
    Called when the plugin is disabled on a running server with the plugin enabled.
  */
  plugin.stop = function () {
    app.debug('stop')
    onStop.forEach(f => f())
    onStop = []
  }

  return plugin
}

