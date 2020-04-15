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
  let pluginOptions 

  plugin.id = PLUGIN_ID
  plugin.name = PLUGIN_NAME
  plugin.description = 'SignalK Plugin to enable N2K Switching'

  plugin.schema = {
    title: PLUGIN_NAME,
    type: 'object',
    properties: {
      maretronCompatibility: {
	type: 'boolean',
	title: 'Maretron Compatibility (Sends command PGN 126208 to update switch status PGN 127501 in addition to the standard switch control PGN 127502)',
	default: false
      }
    }
  }

  function actionHandler(context, path, value, cb) {
    app.debug(`setting ${path} to ${value}`)

    const parts = path.split('.')
    let instance = Number(parts[3])
    let switchNum = Number(parts[4])

    const bankMeta = app.getSelfPath(parts.slice(0, 4).join('.') + '.meta')
    const switchMeta = app.getSelfPath(parts.slice(0, 5).join('.') + '.meta')

    if ( bankMeta && !_.isUndefined(bankMeta.instanceNumber) ) {
      instance = bankMeta.instanceNumber
    }

    if ( switchMeta && !_.isUndefined(switchMeta.instanceNumber) ) {
      switchNum = switchMeta.instanceNumber
    }

    const source = app.getSelfPath(path)
    dst = 255 //broadcast is fine for 127502

    //app.debug(JSON.stringify(source))

    const pgn = {
      pgn: 127502,
      dst: dst,
      "Switch Bank Instance": instance
    }

    pgn[`Switch${switchNum}`] = value === 1 || value === 'on' ? 'On' : 'Off'
    //console.log(JSON.stringify(pgn))
    app.debug('sending %j', pgn)
    app.emit('nmea2000JsonOut', pgn)
    //app.emit('nmea2000out', '2019-04-03T23:40:51.859Z,3,127502,0,169,8,00,10,ff,ff,ff,ff,ff,ff')


    //maretron switch control uses pgn 126208 command to toggle the state via 127501
    if(pluginOptions.maretronCompatibility  === true){

      //the command must be sent to the device, it cannot be sent to the broadcast
      dst = parseInt(source['$source'].split(".")[1])

      //the command parameter for the switch number is shifted by one due to the first parameter being the instance
      switchNum++

      const commandPgn = {
        "pgn":126208,
        "dst": dst,
        "prio":3,
        "fields":{
          "Function Code":"Command",
          "PGN":127501,
          "Priority":8,
          "# of Parameters":2,
          "list":[
            {
               "Parameter":1,
               "Value": instance
            },
            {
               "Parameter": switchNum,
               "Value": value
            }
          ]
        }
      }

      setTimeout(function(){
        app.debug('sending command %j', commandPgn)
        app.emit('nmea2000JsonOut', commandPgn)
      }, 1000)
    }

    let retryCount = 0
    let interval = setInterval(() => {
      var val = app.getSelfPath(path)
      if ( val && val.value == value ) {
	app.debug("SUCCESS")
        cb({ state: 'SUCCESS' })
        clearInterval(interval)
      } else {
        if ( retryCount++ > 5 ) {
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

  function subscription_error(err)
  {
    app.setProviderError(err)
  }
  /*
    Called when the plugin is started (server is started with plugin enabled
    or the plugin is enabled from ui on a running server).
  */
  plugin.start = function (options) {
    pluginOptions = options

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
          const key = `${path}.${update.$source}`
          if ( path.endsWith('state') && registeredPaths.indexOf(key) === -1 ) {
            app.debug('register action handler for path %s source %s', path, update.$source)
            app.registerActionHandler('vessels.self',
                                      path,
                                      actionHandler,
                                      update.$source)
            registeredPaths.push(key)
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
