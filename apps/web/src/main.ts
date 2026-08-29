import './styles.css'
import { createClient, type RealtimeChannel } from '@supabase/supabase-js'
import { Arena, GAME, type Mode, type PublicPlayer, type Snapshot } from '@cell-clash/shared'

type PresencePlayer = { id: string; name: string; color: string; joinedAt: number }
type Result = { winnerId: string | null; results: Array<{ id: string; name: string; score: number }> }
type WireCell = [number, number, number]
type WireFood = [number, number, 0 | 1]
type WireVirus = [number, number, number]
type WireSnapshot = Omit<Snapshot, 'players' | 'foods' | 'viruses'> & {
  players: Array<Omit<PublicPlayer, 'cells'> & { cells: WireCell[] }>
  foods?: WireFood[]
  viruses?: WireVirus[]
}
const SUPABASE_URL = 'https://gnbvicxgcxskeydukdcv.supabase.co'
const SUPABASE_KEY = 'sb_publishable_QhRYsmDW8phF3oVtcTo1Hg_uSlIKYUU'
const ROOM_TOPIC = 'cell-clash:central'
const SNAPSHOT_INTERVAL_MS = 100
const MAP_INTERVAL_MS = 500
const HUD_INTERVAL_MS = 100
const app = document.querySelector<HTMLDivElement>('#app')!
const savedName = localStorage.getItem('cell-clash-name') || `Blob${Math.floor(100 + Math.random() * 900)}`
const playerId = localStorage.getItem('cell-clash-player-id') || crypto.randomUUID()
const joinedAt = Number(localStorage.getItem('cell-clash-joined-at')) || Date.now()
localStorage.setItem('cell-clash-player-id', playerId)
localStorage.setItem('cell-clash-joined-at', String(joinedAt))

let channel: RealtimeChannel
let presence: PresencePlayer[] = []
let arena: Arena | null = null
let snapshot: Snapshot | null = null
let previousSnapshot: Snapshot | null = null
let joined = false
let nickname = savedName
let latestPointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
let hostTimer: number | null = null
let lastSnapshotAt = 0
let lastMapAt = 0
let lastHudAt = 0
let snapshotReceivedAt = 0

app.innerHTML = `
  <section class="shell">
    <header class="topbar"><a class="brand" href="#" aria-label="Cell Clash home"><span class="brand-dot">●</span> CELL CLASH</a><span id="connection" class="connection">CONNECTING</span></header>
    <canvas id="arena" aria-label="Cell Clash game arena"></canvas>
    <aside class="panel left-panel"><div class="eyebrow">YOUR MASS</div><strong id="mass">0</strong><div id="player-status" class="muted">Join the arena to begin.</div><div class="key-help"><span>Move</span><b>Mouse / Touch</b><span>Split</span><b>Space</b><span>Eject mass</span><b>W</b></div></aside>
    <aside class="panel right-panel"><div class="eyebrow">LEADERBOARD</div><ol id="leaderboard" class="leaderboard"></ol><div class="divider"></div><div id="match-status" class="match-status">Central arena · 5 players max</div></aside>
    <section id="lobby" class="lobby-card"><div class="eyebrow">SUPABASE REALTIME ARENA</div><h1>Grow. Split. Dominate.</h1><p id="lobby-copy">One shared arena. Five players max. No bots.</p><label class="name-field">Guest name <input id="name" minlength="2" maxlength="18" autocomplete="nickname" value="" /></label><div id="mode-picker" class="mode-picker"><button data-mode="ffa" class="mode active"><b>FREE FOR ALL</b><small>Every cell for itself</small></button><button data-mode="teams" class="mode"><b>TEAMS</b><small>2 balanced teams</small></button></div><div id="lobby-players" class="lobby-players"></div><button id="join" class="primary">ENTER ARENA</button><button id="start" class="secondary hidden">START MATCH</button><p id="notice" class="notice" role="status"></p></section>
    <div id="action-row" class="action-row hidden"><button id="split" class="action split">SPLIT <kbd>SPACE</kbd></button><button id="eject" class="action">EJECT <kbd>W</kbd></button></div>
    <footer>Cell Clash alpha · GitHub Pages + Supabase Realtime · Guest mode</footer>
  </section>`

const canvas = document.querySelector<HTMLCanvasElement>('#arena')!
const context = canvas.getContext('2d')!
const nameInput = document.querySelector<HTMLInputElement>('#name')!
const joinButton = document.querySelector<HTMLButtonElement>('#join')!
const startButton = document.querySelector<HTMLButtonElement>('#start')!
const lobbyCard = document.querySelector<HTMLElement>('#lobby')!
const notice = document.querySelector<HTMLElement>('#notice')!
nameInput.value = nickname

function say(message: string, isError = false) { notice.textContent = message; notice.classList.toggle('error', isError) }
function setConnection(text: string) { const element = document.querySelector('#connection')!; element.textContent = text; element.className = `connection ${text === 'ONLINE' ? 'online' : ''}` }
function hostId() { return [...presence].sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))[0]?.id ?? null }
function isHost() { return hostId() === playerId }
function currentPlayers(): PublicPlayer[] { return snapshot?.players ?? presence.map((player) => ({ ...player, team: null, cells: [], score: 0, alive: false })) }
function phase() { return snapshot?.phase ?? 'lobby' }
function mode() { return snapshot?.mode ?? 'ffa' }
function escapeHtml(value: string) { const node = document.createElement('span'); node.textContent = value; return node.innerHTML }
function formatTime(value: number) { return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}` }
function send(event: string, payload: Record<string, unknown> = {}) {
  const message = { id: playerId, ...payload }
  // Broadcast deliberately excludes its sender. The current host simulates the
  // authoritative arena, so it must apply its own command before relaying it.
  if (isHost() && event !== 'snapshot') receive(event, message)
  void channel.send({ type: 'broadcast', event, payload: message })
}

function packSnapshot(state: Snapshot, includeMap: boolean): WireSnapshot {
  return {
    tick: state.tick, phase: state.phase, mode: state.mode, timeLeft: state.timeLeft, countdownEndsAt: state.countdownEndsAt,
    leaderboard: state.leaderboard,
    players: state.players.map(({ cells, ...player }) => ({ ...player, cells: cells.map((cell) => [Math.round(cell.x), Math.round(cell.y), Math.round(cell.mass)] as WireCell) })),
    ...(includeMap ? {
      foods: state.foods.map((food) => [Math.round(food.x), Math.round(food.y), food.kind === 'eject' ? 1 : 0] as WireFood),
      viruses: state.viruses.map((virus) => [Math.round(virus.x), Math.round(virus.y), Math.round(virus.radius)] as WireVirus),
    } : {}),
  }
}

function unpackSnapshot(wire: WireSnapshot, prior: Snapshot | null): Snapshot {
  return {
    tick: wire.tick, phase: wire.phase, mode: wire.mode, timeLeft: wire.timeLeft, countdownEndsAt: wire.countdownEndsAt,
    leaderboard: wire.leaderboard,
    players: wire.players.map(({ cells, ...player }) => ({ ...player, cells: cells.map((cell, index) => Array.isArray(cell) ? { id: `${player.id}:${index}`, x: cell[0], y: cell[1], mass: cell[2] } : cell) })),
    foods: wire.foods ? wire.foods.map((food, index) => Array.isArray(food) ? { id: `food:${index}`, x: food[0], y: food[1], mass: food[2] ? 12 : GAME.foodMass, kind: food[2] ? 'eject' as const : 'food' as const } : food) : prior?.foods ?? [],
    viruses: wire.viruses ? wire.viruses.map((virus, index) => Array.isArray(virus) ? { id: `virus:${index}`, x: virus[0], y: virus[1], radius: virus[2] } : virus) : prior?.viruses ?? [],
  }
}

function renderLobby() {
  const players = currentPlayers(); const host = isHost(); const currentPhase = phase(); const activeMatch = currentPhase === 'playing' || currentPhase === 'countdown'
  document.querySelector('#lobby-players')!.innerHTML = players.map((player) => `<div class="lobby-player"><i style="background:${player.color}"></i>${escapeHtml(player.name)}${player.id === hostId() ? '<small>HOST</small>' : ''}${mode() === 'teams' ? `<small>TEAM ${(player.team ?? 0) + 1}</small>` : ''}</div>`).join('') || '<div class="empty">Waiting for challengers…</div>'
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => { const nextMode = button.dataset.mode as Mode; button.classList.toggle('active', mode() === nextMode); button.disabled = !host || activeMatch })
  joinButton.classList.toggle('hidden', joined); startButton.classList.toggle('hidden', !joined || !host || activeMatch); startButton.disabled = players.length < GAME.minimumPlayers
  nameInput.disabled = joined; lobbyCard.classList.toggle('hidden', joined && activeMatch)
  document.querySelector('#action-row')!.classList.toggle('hidden', !joined || currentPhase !== 'playing')
  if (currentPhase === 'countdown' && snapshot?.countdownEndsAt) say(`Match starts in ${Math.max(1, Math.ceil((snapshot.countdownEndsAt - Date.now()) / 1000))}…`)
}
function renderHud() {
  const me = snapshot?.players.find((player) => player.id === playerId)
  document.querySelector('#mass')!.textContent = String(Math.round(me?.score ?? 0))
  document.querySelector('#player-status')!.textContent = snapshot?.phase === 'playing' ? (me?.alive ? 'Absorb cells. Avoid larger rivals.' : 'Reforming…') : 'Ready for the next clash.'
  document.querySelector('#match-status')!.textContent = snapshot?.phase === 'playing' ? `${formatTime(snapshot.timeLeft)} remaining · ${snapshot.mode === 'teams' ? 'Teams' : 'Free for all'}` : 'Central arena · 5 players max'
  document.querySelector('#leaderboard')!.innerHTML = (snapshot?.leaderboard ?? []).map((entry, index) => `<li><span><i style="background:${entry.color}"></i>${escapeHtml(entry.name)}</span><b>${entry.score}</b><em>${index + 1}</em></li>`).join('') || '<li class="empty">No live scores yet</li>'
}

function syncHostArena() {
  if (!isHost()) { arena = null; if (hostTimer) { clearInterval(hostTimer); hostTimer = null }; return }
  if (!arena) { arena = new Arena(); for (const player of [...presence].sort((a, b) => a.joinedAt - b.joinedAt)) { const error = arena.join(player.id, player.name); if (error === 'arena-full') send('rejected', { playerId: player.id }) }; say('You are synchronizing the shared arena.') }
  if (arena.snapshot().phase === 'lobby') {
    const presentIds = new Set(presence.map((player) => player.id))
    for (const id of [...arena.players.keys()]) if (!presentIds.has(id)) arena.leave(id)
    for (const player of [...presence].sort((a, b) => a.joinedAt - b.joinedAt)) { const error = arena.join(player.id, player.name); if (error === 'arena-full') send('rejected', { playerId: player.id }) }
  }
  if (!hostTimer) hostTimer = window.setInterval(hostStep, 1000 / GAME.tickRate)
}
function hostStep() {
  if (!arena || !isHost()) return
  const now = performance.now()
  const result = arena.update(); snapshot = arena.snapshot()
  if (now - lastHudAt >= HUD_INTERVAL_MS || result) { renderHud(); renderLobby(); lastHudAt = now }
  if (now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS || result) {
    const includeMap = now - lastMapAt >= MAP_INTERVAL_MS || lastMapAt === 0
    send('snapshot', { state: packSnapshot(snapshot, includeMap) })
    lastSnapshotAt = now
    if (includeMap) lastMapAt = now
  }
  if (result) send('matchFinished', result as unknown as Record<string, unknown>)
}
function presentIds() { return new Set(presence.map((player) => player.id)) }
function acceptPlayer(id: unknown) { return typeof id === 'string' && presentIds().has(id) }
function receive(event: string, raw: unknown) {
  const payload = raw as Record<string, unknown>
  if (event === 'snapshot' && !isHost()) {
    const state = unpackSnapshot(payload.state as WireSnapshot, snapshot)
    if (state?.players) { previousSnapshot = snapshot; snapshot = state; snapshotReceivedAt = performance.now(); renderHud(); renderLobby() }
    return
  }
  if (event === 'rejected' && payload.playerId === playerId) { joined = false; void channel.untrack(); say('The central arena is full. Try again after this match.', true); renderLobby(); return }
  if (event === 'matchFinished') { const result = payload as unknown as Result; const winner = result.results?.find((entry) => entry.id === result.winnerId); say(winner ? `${winner.name} wins with ${winner.score} mass. Next lobby opens shortly.` : 'Match complete.'); return }
  if (!arena || !isHost() || !acceptPlayer(payload.id)) return
  const id = payload.id as string
  if (event === 'input') arena.input(id, payload.vector)
  if (event === 'split') arena.split(id)
  if (event === 'eject') arena.eject(id)
  if (event === 'startMatch') {
    arena.start(id)
    snapshot = arena.snapshot()
    renderHud()
    renderLobby()
  }
  if (event === 'setMode') {
    arena.setMode(id, payload.mode)
    snapshot = arena.snapshot()
    renderHud()
    renderLobby()
  }
}
function syncPresence() {
  const state = channel.presenceState<PresencePlayer>()
  presence = Object.values(state).flat().map(({ presence_ref: _presenceRef, ...player }) => player).filter((player) => Boolean(player.id && player.name)).sort((a, b) => a.joinedAt - b.joinedAt)
  if (presence.length > GAME.lobbyMax) { say('The central arena is full. Try again after this match.', true); return }
  syncHostArena(); renderLobby()
}

async function connect() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  channel = supabase.channel(ROOM_TOPIC, { config: { broadcast: { self: false }, presence: { key: playerId } } })
  channel.on('presence', { event: 'sync' }, syncPresence).on('broadcast', { event: 'snapshot' }, ({ payload }) => receive('snapshot', payload)).on('broadcast', { event: 'input' }, ({ payload }) => receive('input', payload)).on('broadcast', { event: 'split' }, ({ payload }) => receive('split', payload)).on('broadcast', { event: 'eject' }, ({ payload }) => receive('eject', payload)).on('broadcast', { event: 'startMatch' }, ({ payload }) => receive('startMatch', payload)).on('broadcast', { event: 'setMode' }, ({ payload }) => receive('setMode', payload)).on('broadcast', { event: 'matchFinished' }, ({ payload }) => receive('matchFinished', payload)).on('broadcast', { event: 'rejected' }, ({ payload }) => receive('rejected', payload)).subscribe(async (status) => {
    if (status === 'SUBSCRIBED') { setConnection('ONLINE'); joined = true; localStorage.setItem('cell-clash-name', nickname); await channel.track({ id: playerId, name: nickname, color: colorFor(playerId), joinedAt }); say('You joined the central arena.') }
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { setConnection('OFFLINE'); say('Cannot reach Supabase Realtime.', true) }
  })
}
function colorFor(id: string) { const colors = ['#ff5d6c', '#5fa8ff', '#6edb94', '#ffc35a', '#bc82ff']; let sum = 0; for (const char of id) sum += char.charCodeAt(0); return colors[sum % colors.length]! }

joinButton.addEventListener('click', () => { nickname = nameInput.value.trim(); if (nickname.length < 2 || nickname.length > GAME.maxNameLength) { say('Use a name between 2 and 18 characters.', true); return }; localStorage.setItem('cell-clash-name', nickname); if (!joined) void connect() })
startButton.addEventListener('click', () => send('startMatch'))
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => button.addEventListener('click', () => send('setMode', { mode: button.dataset.mode! })))
document.querySelector('#split')!.addEventListener('click', () => send('split'))
document.querySelector('#eject')!.addEventListener('click', () => send('eject'))
window.addEventListener('keydown', (event) => { if (event.code === 'Space') { event.preventDefault(); send('split') }; if (event.key.toLowerCase() === 'w') send('eject') })
canvas.addEventListener('pointermove', (event) => { const rect = canvas.getBoundingClientRect(); latestPointer = { x: event.clientX - rect.left, y: event.clientY - rect.top } })
canvas.addEventListener('pointerdown', (event) => { if (event.pointerType !== 'mouse') { canvas.setPointerCapture(event.pointerId); send('split') } })
setInterval(() => { const me = snapshot?.players.find((player) => player.id === playerId); if (!me?.cells.length || !joined || phase() !== 'playing') return; send('input', { vector: { x: latestPointer.x - window.innerWidth / 2, y: latestPointer.y - window.innerHeight / 2 } }) }, GAME.inputRateLimitMs)

function cameraFor(player: PublicPlayer) { const center = player.cells.reduce((acc, cell) => ({ x: acc.x + cell.x / player.cells.length, y: acc.y + cell.y / player.cells.length }), { x: 0, y: 0 }); const mass = player.cells.reduce((sum, cell) => sum + cell.mass, 0); return { x: center.x, y: center.y, scale: Math.max(.42, Math.min(1.2, 1 - Math.log10(Math.max(mass, 1)) * .14)) } }
function resize() { const dpr = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.floor(window.innerWidth * dpr); canvas.height = Math.floor(window.innerHeight * dpr); canvas.style.width = `${window.innerWidth}px`; canvas.style.height = `${window.innerHeight}px`; context.setTransform(dpr, 0, 0, dpr, 0, 0) }
window.addEventListener('resize', resize); resize()
function visualSnapshot() {
  if (isHost() || !snapshot || !previousSnapshot) return snapshot
  const progress = Math.min(1, (performance.now() - snapshotReceivedAt) / SNAPSHOT_INTERVAL_MS)
  return {
    ...snapshot,
    players: snapshot.players.map((player) => {
      const previousPlayer = previousSnapshot?.players.find((candidate) => candidate.id === player.id)
      return { ...player, cells: player.cells.map((cell, index) => {
        const previousCell = previousPlayer?.cells[index]
        return previousCell ? { ...cell, x: previousCell.x + (cell.x - previousCell.x) * progress, y: previousCell.y + (cell.y - previousCell.y) * progress } : cell
      }) }
    }),
  }
}
function draw() { const width = window.innerWidth, height = window.innerHeight; const frame = visualSnapshot(); context.clearRect(0, 0, width, height); const me = frame?.players.find((player) => player.id === playerId); const camera = me?.cells.length ? cameraFor(me) : { x: GAME.mapSize / 2, y: GAME.mapSize / 2, scale: .55 }; context.save(); context.translate(width / 2, height / 2); context.scale(camera.scale, camera.scale); context.translate(-camera.x, -camera.y); drawGrid(camera, width, height); for (const food of frame?.foods ?? []) { context.fillStyle = food.kind === 'eject' ? '#ffe373' : '#77dfab'; context.beginPath(); context.arc(food.x, food.y, food.kind === 'eject' ? 8 : 4, 0, Math.PI * 2); context.fill() } for (const virus of frame?.viruses ?? []) { context.fillStyle = '#78ca6c'; context.beginPath(); context.arc(virus.x, virus.y, virus.radius, 0, Math.PI * 2); context.fill(); context.strokeStyle = '#b4ef97'; context.lineWidth = 4; context.stroke() } for (const player of frame?.players ?? []) for (const cell of player.cells) drawCell(cell, player, me?.id === player.id); context.restore(); requestAnimationFrame(draw) }
function drawGrid(camera: { x: number; y: number; scale: number }, width: number, height: number) { const gap = 120, viewW = width / camera.scale, viewH = height / camera.scale; context.strokeStyle = 'rgba(151, 193, 235, .10)'; context.lineWidth = 1; for (let x = Math.floor((camera.x - viewW / 2) / gap) * gap; x < camera.x + viewW / 2; x += gap) { context.beginPath(); context.moveTo(x, camera.y - viewH / 2); context.lineTo(x, camera.y + viewH / 2); context.stroke() } for (let y = Math.floor((camera.y - viewH / 2) / gap) * gap; y < camera.y + viewH / 2; y += gap) { context.beginPath(); context.moveTo(camera.x - viewW / 2, y); context.lineTo(camera.x + viewW / 2, y); context.stroke() } }
function drawCell(cell: { x: number; y: number; mass: number }, player: PublicPlayer, isMe: boolean) { const radius = Math.sqrt(cell.mass) * 4; context.beginPath(); context.arc(cell.x, cell.y, radius, 0, Math.PI * 2); context.fillStyle = player.color; context.fill(); context.lineWidth = isMe ? 5 : 3; context.strokeStyle = isMe ? '#fff6cc' : 'rgba(255,255,255,.7)'; context.stroke(); if (radius > 24) { context.fillStyle = '#102039'; context.font = `700 ${Math.max(13, radius / 2.7)}px system-ui`; context.textAlign = 'center'; context.fillText(player.name, cell.x, cell.y + 5) } }
draw(); renderLobby()
