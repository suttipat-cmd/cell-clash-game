import assert from 'node:assert/strict'
import test from 'node:test'
import { Arena, GAME, cleanGuestName, radiusForMass, speedForMass } from './index.js'

test('guest names are bounded and sanitized', () => {
  assert.equal(cleanGuestName('  Player   One  '), 'Player One')
  assert.equal(cleanGuestName('<good>'), 'good')
  assert.equal(cleanGuestName('A'), null)
  assert.equal(cleanGuestName('x'.repeat(GAME.maxNameLength + 1)), null)
})

test('larger cells have larger radius but lower speed', () => {
  assert.ok(radiusForMass(400) > radiusForMass(100))
  assert.ok(speedForMass(400) < speedForMass(100))
})

test('the host can start a match when two players are present', () => {
  const arena = new Arena()
  assert.equal(arena.join('host', 'Alpha'), null)
  assert.equal(arena.join('guest', 'Bravo'), null)
  assert.equal(arena.start('host'), null)
  assert.equal(arena.snapshot().phase, 'countdown')
})
