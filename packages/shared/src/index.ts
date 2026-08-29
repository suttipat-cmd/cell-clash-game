export const GAME = {
  mapSize: 3600,
  tickRate: 25,
  lobbyMax: 5,
  minimumPlayers: 2,
  matchSeconds: 480,
  foodTarget: 260,
  virusTarget: 12,
  startingMass: 120,
  foodMass: 2,
  maxNameLength: 18,
  inputRateLimitMs: 40,
  splitCooldownMs: 1000,
  ejectCooldownMs: 180,
  respawnSeconds: 3,
} as const

export type Mode = 'ffa' | 'teams'
export type Phase = 'lobby' | 'countdown' | 'playing' | 'finished'

export interface Vec { x: number; y: number }
export interface Food extends Vec { id: string; mass: number; kind: 'food' | 'eject' }
export interface Virus extends Vec { id: string; radius: number }
export interface Cell extends Vec { id: string; mass: number; vx: number; vy: number; mergeAt: number }
export interface Player {
  id: string
  name: string
  color: string
  team: 0 | 1 | null
  cells: Cell[]
  score: number
  alive: boolean
  respawnAt: number | null
  joinedAt: number
  lastSplitAt: number
  lastEjectAt: number
}

export interface PublicPlayer {
  id: string; name: string; color: string; team: 0 | 1 | null
  cells: Array<Pick<Cell, 'id' | 'x' | 'y' | 'mass'>>
  score: number; alive: boolean
}

export interface Snapshot {
  tick: number
  phase: Phase
  mode: Mode
  timeLeft: number
  countdownEndsAt: number | null
  players: PublicPlayer[]
  foods: Food[]
  viruses: Virus[]
  leaderboard: Array<{ id: string; name: string; score: number; color: string }>
}

export interface MatchResult {
  mode: Mode
  winnerId: string | null
  results: Array<{ id: string; name: string; score: number; placement: number }>
}

export const radiusForMass = (mass: number) => Math.sqrt(Math.max(mass, 1)) * 4
export const speedForMass = (mass: number) => Math.max(80, 420 / Math.pow(Math.max(mass, 1), 0.24))
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
export const distanceSquared = (a: Vec, b: Vec) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2

export function cleanGuestName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.normalize('NFKC').replace(/[\u0000-\u001f<>]/g, '').trim().replace(/\s+/g, ' ')
  if (name.length < 2 || name.length > GAME.maxNameLength) return null
  return name
}

export function createSpawn(id: string, mass = GAME.startingMass): Cell {
  return { id, x: GAME.mapSize / 2, y: GAME.mapSize / 2, mass, vx: 0, vy: 0, mergeAt: 0 }
}

export function publicPlayer(player: Player): PublicPlayer {
  return {
    id: player.id, name: player.name, color: player.color, team: player.team,
    score: Math.round(player.score), alive: player.alive,
    cells: player.cells.map(({ id, x, y, mass }) => ({ id, x: Math.round(x), y: Math.round(y), mass: Math.round(mass) })),
  }
}
