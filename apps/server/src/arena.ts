import {
  clamp, cleanGuestName, createSpawn, distanceSquared, GAME, type Cell, type Food, type Mode, type Phase,
  type MatchResult, type Player, type Snapshot, type Vec, type Virus, publicPlayer, radiusForMass, speedForMass,
} from '@cell-clash/shared'

const COLORS = ['#ff5d6c', '#5fa8ff', '#6edb94', '#ffc35a', '#bc82ff']
const randomId = () => crypto.randomUUID()
const randomPoint = (padding = 100): Vec => ({
  x: padding + Math.random() * (GAME.mapSize - padding * 2),
  y: padding + Math.random() * (GAME.mapSize - padding * 2),
})

export type ArenaError = 'invalid-name' | 'arena-full' | 'match-in-progress' | 'not-host' | 'not-enough-players' | 'invalid-mode'

export class Arena {
  readonly players = new Map<string, Player>()
  private readonly directions = new Map<string, Vec>()
  private foods: Food[] = []
  private viruses: Virus[] = []
  private phase: Phase = 'lobby'
  private mode: Mode = 'ffa'
  private countdownEndsAt: number | null = null
  private matchEndsAt: number | null = null
  private tick = 0
  private hostId: string | null = null
  private lastFinishedAt: number | null = null
  private finishedResult: MatchResult | null = null

  constructor() { this.seedMap() }

  join(id: string, nameInput: unknown): ArenaError | null {
    const name = cleanGuestName(nameInput)
    if (!name) return 'invalid-name'
    if (this.players.has(id)) return null
    if (this.phase === 'playing' || this.phase === 'countdown') return 'match-in-progress'
    if (this.players.size >= GAME.lobbyMax) return 'arena-full'
    this.players.set(id, {
      id, name, color: COLORS[this.players.size % COLORS.length], team: null, cells: [], score: 0, alive: false,
      respawnAt: null, joinedAt: Date.now(), lastSplitAt: 0, lastEjectAt: 0,
    })
    this.hostId ??= id
    this.assignTeams()
    return null
  }

  leave(id: string) {
    this.players.delete(id)
    this.directions.delete(id)
    if (this.hostId === id) this.hostId = this.players.keys().next().value ?? null
    if (this.players.size < GAME.minimumPlayers && this.phase === 'countdown') {
      this.phase = 'lobby'; this.countdownEndsAt = null
    }
    if (this.players.size === 0) this.resetToLobby()
    else this.assignTeams()
  }

  setMode(id: string, mode: unknown): ArenaError | null {
    if (id !== this.hostId) return 'not-host'
    if (this.phase !== 'lobby') return 'match-in-progress'
    if (mode !== 'ffa' && mode !== 'teams') return 'invalid-mode'
    this.mode = mode
    this.assignTeams()
    return null
  }

  start(id: string): ArenaError | null {
    if (id !== this.hostId) return 'not-host'
    if (this.phase !== 'lobby') return 'match-in-progress'
    if (this.players.size < GAME.minimumPlayers) return 'not-enough-players'
    this.phase = 'countdown'
    this.countdownEndsAt = Date.now() + 5000
    return null
  }

  input(id: string, vector: unknown) {
    if (this.phase !== 'playing' || !this.players.has(id) || !isVec(vector)) return
    const length = Math.hypot(vector.x, vector.y)
    this.directions.set(id, length > 0.001 ? { x: vector.x / Math.max(1, length), y: vector.y / Math.max(1, length) } : { x: 0, y: 0 })
  }

  split(id: string) {
    const player = this.players.get(id)
    const direction = this.directions.get(id) ?? { x: 1, y: 0 }
    const now = Date.now()
    if (!player || this.phase !== 'playing' || !player.alive || now - player.lastSplitAt < GAME.splitCooldownMs || player.cells.length >= 4) return
    const source = [...player.cells].sort((a, b) => b.mass - a.mass)[0]
    if (!source || source.mass < 90) return
    const half = source.mass / 2
    source.mass = half
    player.cells.push({
      id: randomId(), x: source.x + direction.x * radiusForMass(half), y: source.y + direction.y * radiusForMass(half),
      mass: half, vx: direction.x * 620, vy: direction.y * 620, mergeAt: now + 12_000,
    })
    player.lastSplitAt = now
  }

  eject(id: string) {
    const player = this.players.get(id)
    const direction = this.directions.get(id) ?? { x: 1, y: 0 }
    const now = Date.now()
    if (!player || this.phase !== 'playing' || !player.alive || now - player.lastEjectAt < GAME.ejectCooldownMs) return
    const source = [...player.cells].sort((a, b) => b.mass - a.mass)[0]
    if (!source || source.mass < 38) return
    const mass = 12
    source.mass -= mass
    const radius = radiusForMass(source.mass)
    this.foods.push({ id: randomId(), x: source.x + direction.x * (radius + 14), y: source.y + direction.y * (radius + 14), mass, kind: 'eject' })
    player.lastEjectAt = now
  }

  update(): MatchResult | null {
    const now = Date.now()
    if (this.phase === 'countdown' && this.countdownEndsAt && now >= this.countdownEndsAt) this.beginMatch(now)
    if (this.phase === 'finished' && this.lastFinishedAt && now - this.lastFinishedAt >= 10_000) this.resetToLobby()
    if (this.phase !== 'playing') return this.takeFinishedResult()
    this.tick += 1
    const dt = 1 / GAME.tickRate
    for (const player of this.players.values()) {
      if (!player.alive) {
        if (player.respawnAt && now >= player.respawnAt) this.spawnPlayer(player)
        continue
      }
      const direction = this.directions.get(player.id) ?? { x: 0, y: 0 }
      for (const cell of player.cells) this.moveCell(cell, direction, dt)
      this.mergeCells(player, now)
    }
    this.consumeFood()
    this.consumeViruses(now)
    this.consumePlayers(now)
    for (const player of this.players.values()) player.score = player.cells.reduce((sum, cell) => sum + cell.mass, 0)
    this.refillMap()
    if (this.matchEndsAt && now >= this.matchEndsAt) this.finishMatch(now)
    return this.takeFinishedResult()
  }

  snapshot(): Snapshot {
    const players = [...this.players.values()].map(publicPlayer)
    return {
      tick: this.tick, phase: this.phase, mode: this.mode,
      timeLeft: this.matchEndsAt && this.phase === 'playing' ? Math.max(0, Math.ceil((this.matchEndsAt - Date.now()) / 1000)) : GAME.matchSeconds,
      countdownEndsAt: this.countdownEndsAt,
      players, foods: this.foods, viruses: this.viruses,
      leaderboard: players.map((p) => ({ id: p.id, name: p.name, score: p.score, color: p.color })).sort((a, b) => b.score - a.score).slice(0, 5),
    }
  }

  lobbyState() {
    return { phase: this.phase, mode: this.mode, hostId: this.hostId, maxPlayers: GAME.lobbyMax, players: [...this.players.values()].map(publicPlayer), countdownEndsAt: this.countdownEndsAt }
  }

  private beginMatch(now: number) {
    if (this.players.size < GAME.minimumPlayers) { this.phase = 'lobby'; this.countdownEndsAt = null; return }
    this.phase = 'playing'; this.countdownEndsAt = null; this.matchEndsAt = now + GAME.matchSeconds * 1000
    for (const player of this.players.values()) this.spawnPlayer(player)
  }

  private finishMatch(now: number) {
    this.phase = 'finished'; this.matchEndsAt = null; this.lastFinishedAt = now
    const results = [...this.players.values()].map((player) => ({ id: player.id, name: player.name, score: Math.round(player.score), placement: 0 })).sort((a, b) => b.score - a.score)
    results.forEach((result, index) => { result.placement = index + 1 })
    this.finishedResult = { mode: this.mode, winnerId: results[0]?.id ?? null, results }
  }
  private takeFinishedResult() { const result = this.finishedResult; this.finishedResult = null; return result }

  private resetToLobby() {
    this.phase = 'lobby'; this.countdownEndsAt = null; this.matchEndsAt = null; this.lastFinishedAt = null; this.finishedResult = null; this.tick = 0
    for (const player of this.players.values()) { player.cells = []; player.score = 0; player.alive = false; player.respawnAt = null }
    this.foods = []; this.viruses = []; this.seedMap()
  }

  private seedMap() { this.refillMap(); while (this.viruses.length < GAME.virusTarget) this.viruses.push({ id: randomId(), ...randomPoint(260), radius: 42 }) }
  private refillMap() { while (this.foods.length < GAME.foodTarget) this.foods.push({ id: randomId(), ...randomPoint(), mass: GAME.foodMass, kind: 'food' }) }
  private assignTeams() { if (this.mode !== 'teams') { for (const p of this.players.values()) p.team = null; return }; [...this.players.values()].forEach((p, index) => { p.team = (index % 2) as 0 | 1 }) }
  private spawnPlayer(player: Player) {
    const point = randomPoint(420)
    player.cells = [{ ...createSpawn(randomId()), ...point }]
    player.score = GAME.startingMass; player.alive = true; player.respawnAt = null
  }
  private moveCell(cell: Cell, direction: Vec, dt: number) {
    const speed = speedForMass(cell.mass)
    cell.vx = cell.vx * 0.88 + direction.x * speed * 0.12
    cell.vy = cell.vy * 0.88 + direction.y * speed * 0.12
    cell.x = clamp(cell.x + cell.vx * dt, radiusForMass(cell.mass), GAME.mapSize - radiusForMass(cell.mass))
    cell.y = clamp(cell.y + cell.vy * dt, radiusForMass(cell.mass), GAME.mapSize - radiusForMass(cell.mass))
  }
  private mergeCells(player: Player, now: number) {
    for (let i = player.cells.length - 1; i >= 0; i--) for (let j = i - 1; j >= 0; j--) {
      const a = player.cells[i], b = player.cells[j]
      if (!a || !b || now < Math.max(a.mergeAt, b.mergeAt)) continue
      if (distanceSquared(a, b) < Math.max(radiusForMass(a.mass), radiusForMass(b.mass)) ** 2 * 0.35) { a.mass += b.mass; player.cells.splice(j, 1) }
    }
    player.score = player.cells.reduce((sum, cell) => sum + cell.mass, 0)
  }
  private consumeFood() {
    for (const player of this.players.values()) if (player.alive) for (const cell of player.cells) {
      const radius = radiusForMass(cell.mass)
      for (let i = this.foods.length - 1; i >= 0; i--) { const food = this.foods[i]; if (food && distanceSquared(cell, food) < radius ** 2) { cell.mass += food.mass; this.foods.splice(i, 1) } }
      player.score = player.cells.reduce((sum, item) => sum + item.mass, 0)
    }
  }
  private consumeViruses(now: number) {
    for (const player of this.players.values()) if (player.alive) for (const cell of [...player.cells]) for (const virus of this.viruses) {
      if (cell.mass < 180 || distanceSquared(cell, virus) > (radiusForMass(cell.mass) + virus.radius * 0.45) ** 2 || player.cells.length >= 4) continue
      const half = cell.mass / 2; cell.mass = half
      player.cells.push({ id: randomId(), x: clamp(cell.x + 55, 60, GAME.mapSize - 60), y: clamp(cell.y - 55, 60, GAME.mapSize - 60), mass: half, vx: 180, vy: -180, mergeAt: now + 12_000 })
    }
  }
  private consumePlayers(now: number) {
    const entries = [...this.players.values()]
    for (const eater of entries) if (eater.alive) for (const target of entries) {
      if (!target.alive || target.id === eater.id || (this.mode === 'teams' && target.team === eater.team)) continue
      for (const large of eater.cells) for (let i = target.cells.length - 1; i >= 0; i--) {
        const small = target.cells[i]; if (!small || large.mass < small.mass * 1.28) continue
        if (distanceSquared(large, small) < (radiusForMass(large.mass) - radiusForMass(small.mass) * 0.3) ** 2) { large.mass += small.mass; target.cells.splice(i, 1) }
      }
      if (target.cells.length === 0) { target.alive = false; target.respawnAt = now + GAME.respawnSeconds * 1000 }
    }
  }
}

function isVec(value: unknown): value is Vec { return typeof value === 'object' && value !== null && Number.isFinite((value as Vec).x) && Number.isFinite((value as Vec).y) }
