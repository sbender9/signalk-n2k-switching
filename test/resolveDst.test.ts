import assert from 'node:assert/strict'
import { resolveDstFromSource } from '../src/resolveDst'

/**
 * A minimal stand-in for the bits of the Signal K `app` object that
 * `resolveDstFromSource` reads. It only needs `app.signalk.retrieve()` to
 * return an object with a `sources` map, so we build exactly that shape.
 */
type SourceEntry = { canName?: string; n2k?: { canName?: string } }
type Sources = Record<string, Record<string, SourceEntry>>

function makeApp(sources?: Sources): unknown {
  return {
    signalk: {
      retrieve: () => (sources === undefined ? {} : { sources })
    }
  }
}

describe('resolveDstFromSource', () => {
  describe('decimal fast-path (canboatjs / ydwg02 style $source)', () => {
    it('returns the trailing decimal address verbatim', () => {
      assert.equal(resolveDstFromSource(makeApp(), 'canboatjs.31'), 31)
    })

    it('handles address 0 (a valid unicast destination)', () => {
      assert.equal(resolveDstFromSource(makeApp(), 'canboatjs.0'), 0)
    })

    it('handles the top valid unicast address 251', () => {
      assert.equal(resolveDstFromSource(makeApp(), 'canboatjs.251'), 251)
    })

    it('splits on the LAST dot so dotted labels still resolve', () => {
      // Provider label itself contains dots (an IP); the address is the
      // final segment, not whatever follows the first dot.
      assert.equal(
        resolveDstFromSource(makeApp(), 'Maretron-IPG-192.168.0.179.42'),
        42
      )
    })
  })

  describe('address boundary validation', () => {
    it('rejects 252 (reserved, not a unicast destination)', () => {
      assert.equal(resolveDstFromSource(makeApp(), 'canboatjs.252'), undefined)
    })

    it('rejects 254 (the N2K null address)', () => {
      assert.equal(resolveDstFromSource(makeApp(), 'canboatjs.254'), undefined)
    })

    it('rejects 255 (the N2K broadcast address)', () => {
      // Sending a Maretron command PGN to the broadcast address is exactly
      // what the caller guards against, so this must not resolve.
      assert.equal(resolveDstFromSource(makeApp(), 'canboatjs.255'), undefined)
    })
  })

  describe('canName slow-path (MaretronIPG / N2kIpGateway useCanName:true)', () => {
    const canName = 'c03c8c0c1139f548'
    const label = 'Maretron-IPG-192.168.0.179'
    const srcString = `${label}.${canName}`

    it('resolves the numeric address whose canName matches the hex tail', () => {
      const app = makeApp({
        [label]: {
          '7': { canName: 'aaaaaaaaaaaaaaaa' },
          '23': { canName }
        }
      })
      assert.equal(resolveDstFromSource(app, srcString), 23)
    })

    it('also matches a canName nested under entry.n2k.canName', () => {
      const app = makeApp({
        [label]: {
          '23': { n2k: { canName } }
        }
      })
      assert.equal(resolveDstFromSource(app, srcString), 23)
    })

    it('returns undefined when no entry has a matching canName', () => {
      const app = makeApp({
        [label]: {
          '23': { canName: 'deadbeefdeadbeef' }
        }
      })
      assert.equal(resolveDstFromSource(app, srcString), undefined)
    })

    it('ignores a matching canName whose address is out of range (e.g. 254)', () => {
      const app = makeApp({
        [label]: {
          '254': { canName }
        }
      })
      assert.equal(resolveDstFromSource(app, srcString), undefined)
    })

    it('returns undefined when the label is absent from the sources map', () => {
      const app = makeApp({
        'some-other-label': { '23': { canName } }
      })
      assert.equal(resolveDstFromSource(app, srcString), undefined)
    })

    it('ignores a matching canName under a non-numeric address key', () => {
      // The registry is documented as keyed by numeric CAN address; a
      // non-numeric key parses to NaN and must be skipped by the guard.
      const app = makeApp({
        [label]: {
          foo: { canName }
        }
      })
      assert.equal(resolveDstFromSource(app, srcString), undefined)
    })
  })

  describe('degenerate / missing inputs', () => {
    it('returns undefined for a non-numeric tail with no sources registry', () => {
      // app.signalk.retrieve() returns no `sources`, so the slow path has
      // nothing to walk.
      assert.equal(
        resolveDstFromSource(makeApp(), 'Maretron-IPG.c03c8c0c1139f548'),
        undefined
      )
    })

    it('returns undefined when app has no signalk.retrieve at all', () => {
      // Optional chaining must swallow a bare/partial app object.
      assert.equal(resolveDstFromSource({}, 'Maretron-IPG.abc'), undefined)
    })

    it('returns undefined for a dotless, non-numeric $source', () => {
      assert.equal(resolveDstFromSource(makeApp(), 'mysource'), undefined)
    })

    it('treats a bare decimal $source (no label) as a direct address', () => {
      // lastDot === -1, so label === tail === '99'; the fast path applies.
      assert.equal(resolveDstFromSource(makeApp(), '99'), 99)
    })

    it('returns undefined for an empty $source', () => {
      assert.equal(resolveDstFromSource(makeApp(), ''), undefined)
    })
  })
})
