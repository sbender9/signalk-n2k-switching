# signalk-n2k-switching

Provides node server with the ability to control switching devices that use standard N2K PGNs (via PUT requests).

Maretron compatibility will also send switch controls via the Command PGN.

Currently tested with the Yacht Devices Circuit Control YDCC-04 and Maretron DCR100.

To control a switch you use PUT requestus via HTTP or over a WebSocket. See https://signalk.org/specification/1.4.0/doc/put.html and https://signalk.org/specification/1.4.0/doc/request_response.html.

For example:
```
{
  "requestId": "123345-23232-232323",
  "put": {
    "path": "electrical.switches.anchorLight.state",
    "value": 1
  }
}
```
