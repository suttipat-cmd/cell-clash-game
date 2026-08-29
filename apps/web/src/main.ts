import './styles.css'
import { createClient } from '@supabase/supabase-js'
import { io, type Socket } from 'socket.io-client'
import { GAME, type Mode, type PublicPlayer, type Snapshot } from '@cell-clash/shared'

type Lobby = { phase: 'lobby' | 'countdown' | 'playing' | 'finished'; mode: Mode; hostId: string | null; maxPlayers: number; players: PublicPlayer[]; countdownEndsAt: number | null }
const app = document.querySelector<HTMLDivElement>('#app')!
const savedName = localStorage.getItem('cell-clash-name') || `Blob${Math.floor(100 + Math.random() * 900)}`
const serverUrl = import.meta.env.VITE_GAME_SERVER_URL || undefined
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
let socket: Socket
let myId = ''
let snapshot: Snapshot | null = null
let lobby: Lobby | null = null
let joined = false
let latestPointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
let nickname = savedName

app.innerHTML = `
  <section class="shell">
    <header class="topbar"><a class="brand" href="#" aria-label="Cell Clash home"><span class="brand-dot">●</span> CELL CLASH</a><span id="connection" class="connection">CONNECTING</span></header>
    <canvas id="arena" aria-label="Cell Clash game arena"></canvas>
    <aside class="panel left-panel"><div class="eyebrow">YOUR MASS</div><strong id="mass">0</strong><div id="player-status" class="muted">Join the arena to begin.</div><div class="key-help"><span>Move</span><b>Mouse / Touch</b><span>Split</span><b>Space</b><span>Eject mass</span><b>W</b></div></aside>
    <aside class="panel right-panel"><div class="eyebrow">LEADERBOARD</div><ol id="leaderboard" class="leaderboard"></ol><div class="divider"></div><div id="match-status" class="match-status">Central arena · 5 players max</div></aside>
    <section id="lobby" class="lobby-card"><div class="eyebrow">ONLINE ARENA</div><h1>Grow. Split. Dominate.</h1><p id="lobby-copy">One shared arena. Five players max. No bots.</p><label class="name-field">Guest name <input id="name" minlength="2" maxlength="18" autocomplete="nickname" value="" /></label><div id="mode-picker" class="mode-picker"><button data-mode="ffa" class="mode active"><b>FREE FOR ALL</b><small>Every cell for itself</small></button><button data-mode="teams" class="mode"><b>TEAMS</b><small>2 balanced teams</small></button></div><div id="lobby-players" class="lobby-players"></div><button id="join" class="primary">ENTER ARENA</button><button id="start" class="secondary hidden">START MATCH</button><p id="notice" class="notice" role="status"></p></section>
    <div id="action-row" class="action-row hidden"><button id="split" class="action split">SPLIT <kbd>SPACE</kbd></button><button id="eject" class="action">EJECT <kbd>W</kbd></button></div>
    <footer>Cell Clash alpha · Server-authoritative multiplayer · Guest mode</footer>
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
function friendlyError(code: string) {
  return ({ 'invalid-name': 'Use a name between 2 and 18 characters.', 'arena-full': 'The central arena is full. Try again after this match.', 'match-in-progress': 'A match is already active. Please wait for the next round.', 'not-host': 'Only the first player in the lobby can change this.', 'not-enough-players': 'At least two players are required.', 'invalid-mode': 'That mode is unavailable.' } as Record<string, string>)[code] ?? 'Something went wrong. Please reconnect.'
}

async function connect() {
  let token: string | undefined
  if (supabaseUrl && supabaseKey) {
    const client = createClient(supabaseUrl, supabaseKey)
    const { data, error } = await client.auth.signInAnonymously()
    if (error) say('Guest sign-in is not enabled yet. Local development mode is active.', false)
    token = data.session?.access_token
  }
  socket = io(serverUrl, { auth: { token }, transports: ['websocket', 'polling'] })
  socket.on('connect', () => { setConnection('ONLINE'); if (joined) socket.emit('joinArena', { name: nickname }) })
  socket.on('disconnect', () => setConnection('RECONNECTING'))
  socket.on('connect_error', () => { setConnection('OFFLINE'); say('Cannot reach the game server.', true) })
  socket.on('joined', ({ id }) => { myId = id; joined = true; localStorage.setItem('cell-clash-name', nickname); say('You joined the central arena.'); renderLobby() })
  socket.on('gameError', ({ code }) => say(friendlyError(code), true))
  socket.on('lobby', (next: Lobby) => { lobby = next; renderLobby() })
  socket.on('snapshot', (next: Snapshot) => { snapshot = next; renderHud(); renderLobby(); })
  socket.on('matchFinished', ({ winnerId, results }: { winnerId: string | null; results: Array<{ id: string; name: string; score: number }> }) => {
    const winner = results.find((result) => result.id === winnerId)
    say(winner ? `${winner.name} wins with ${winner.score} mass. Next lobby opens shortly.` : 'Match complete. Next lobby opens shortly.')
  })
}

function setConnection(text: string) { const element = document.querySelector('#connection')!; element.textContent = text; element.className = `connection ${text === 'ONLINE' ? 'online' : ''}` }
function renderLobby() {
  if (!lobby) return
  const currentLobby = lobby
  const host = currentLobby.hostId === myId
  const activeMatch = currentLobby.phase === 'playing' || currentLobby.phase === 'countdown'
  const playerList = document.querySelector('#lobby-players')!
  playerList.innerHTML = currentLobby.players.map((player) => `<div class="lobby-player"><i style="background:${player.color}"></i>${escapeHtml(player.name)}${player.id === currentLobby.hostId ? '<small>HOST</small>' : ''}${currentLobby.mode === 'teams' ? `<small>TEAM ${(player.team ?? 0) + 1}</small>` : ''}</div>`).join('') || '<div class="empty">Waiting for challengers…</div>'
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => { const mode = button.dataset.mode as Mode; button.classList.toggle('active', currentLobby.mode === mode); button.disabled = !host || activeMatch })
  joinButton.classList.toggle('hidden', joined)
  startButton.classList.toggle('hidden', !joined || !host || activeMatch)
  startButton.disabled = currentLobby.players.length < GAME.minimumPlayers
  nameInput.disabled = joined
  lobbyCard.classList.toggle('hidden', joined && activeMatch)
  document.querySelector('#action-row')!.classList.toggle('hidden', !joined || !activeMatch || currentLobby.phase !== 'playing')
  if (currentLobby.phase === 'countdown' && currentLobby.countdownEndsAt) say(`Match starts in ${Math.max(1, Math.ceil((currentLobby.countdownEndsAt - Date.now()) / 1000))}…`)
}
function renderHud() {
  const me = snapshot?.players.find((player) => player.id === myId)
  document.querySelector('#mass')!.textContent = String(Math.round(me?.score ?? 0))
  document.querySelector('#player-status')!.textContent = snapshot?.phase === 'playing' ? (me?.alive ? 'Absorb cells. Avoid larger rivals.' : 'Reforming…') : 'Ready for the next clash.'
  document.querySelector('#match-status')!.textContent = snapshot?.phase === 'playing' ? `${formatTime(snapshot.timeLeft)} remaining · ${snapshot.mode === 'teams' ? 'Teams' : 'Free for all'}` : 'Central arena · 5 players max'
  document.querySelector('#leaderboard')!.innerHTML = (snapshot?.leaderboard ?? []).map((entry, index) => `<li><span><i style="background:${entry.color}"></i>${escapeHtml(entry.name)}</span><b>${entry.score}</b><em>${index + 1}</em></li>`).join('') || '<li class="empty">No live scores yet</li>'
}
function formatTime(value: number) { return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}` }
function escapeHtml(value: string) { const node = document.createElement('span'); node.textContent = value; return node.innerHTML }

joinButton.addEventListener('click', () => { nickname = nameInput.value.trim(); socket.emit('joinArena', { name: nickname }) })
startButton.addEventListener('click', () => socket.emit('startMatch'))
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => button.addEventListener('click', () => socket.emit('setMode', button.dataset.mode)))
document.querySelector('#split')!.addEventListener('click', () => socket.emit('split'))
document.querySelector('#eject')!.addEventListener('click', () => socket.emit('eject'))
window.addEventListener('keydown', (event) => { if (event.code === 'Space') { event.preventDefault(); socket.emit('split') }; if (event.key.toLowerCase() === 'w') socket.emit('eject') })
canvas.addEventListener('pointermove', (event) => { const rect = canvas.getBoundingClientRect(); latestPointer = { x: event.clientX - rect.left, y: event.clientY - rect.top } })
canvas.addEventListener('pointerdown', (event) => { if (event.pointerType !== 'mouse') { canvas.setPointerCapture(event.pointerId); socket.emit('split') } })
setInterval(() => {
  const me = snapshot?.players.find((player) => player.id === myId); if (!me?.cells.length || !joined) return
  socket.emit('input', { x: latestPointer.x - window.innerWidth / 2, y: latestPointer.y - window.innerHeight / 2 })
}, GAME.inputRateLimitMs)

function cameraFor(player: PublicPlayer) {
  const center = player.cells.reduce((acc, cell) => ({ x: acc.x + cell.x / player.cells.length, y: acc.y + cell.y / player.cells.length }), { x: 0, y: 0 })
  const mass = player.cells.reduce((sum, cell) => sum + cell.mass, 0)
  return { x: center.x, y: center.y, scale: Math.max(.42, Math.min(1.2, 1 - Math.log10(Math.max(mass, 1)) * .14)) }
}
function resize() { const dpr = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.floor(window.innerWidth * dpr); canvas.height = Math.floor(window.innerHeight * dpr); canvas.style.width = `${window.innerWidth}px`; canvas.style.height = `${window.innerHeight}px`; context.setTransform(dpr, 0, 0, dpr, 0, 0) }
window.addEventListener('resize', resize); resize()

function draw() {
  const width = window.innerWidth, height = window.innerHeight
  context.clearRect(0, 0, width, height)
  const me = snapshot?.players.find((player) => player.id === myId)
  const camera = me?.cells.length ? cameraFor(me) : { x: GAME.mapSize / 2, y: GAME.mapSize / 2, scale: .55 }
  context.save(); context.translate(width / 2, height / 2); context.scale(camera.scale, camera.scale); context.translate(-camera.x, -camera.y)
  drawGrid(camera, width, height)
  for (const food of snapshot?.foods ?? []) { context.fillStyle = food.kind === 'eject' ? '#ffe373' : '#77dfab'; context.beginPath(); context.arc(food.x, food.y, food.kind === 'eject' ? 8 : 4, 0, Math.PI * 2); context.fill() }
  for (const virus of snapshot?.viruses ?? []) { context.fillStyle = '#78ca6c'; context.beginPath(); context.arc(virus.x, virus.y, virus.radius, 0, Math.PI * 2); context.fill(); context.strokeStyle = '#b4ef97'; context.lineWidth = 4; context.stroke() }
  for (const player of snapshot?.players ?? []) for (const cell of player.cells) drawCell(cell, player, me?.id === player.id)
  context.restore(); requestAnimationFrame(draw)
}
function drawGrid(camera: { x: number; y: number; scale: number }, width: number, height: number) {
  const gap = 120; const viewW = width / camera.scale, viewH = height / camera.scale
  context.strokeStyle = 'rgba(151, 193, 235, .10)'; context.lineWidth = 1
  for (let x = Math.floor((camera.x - viewW / 2) / gap) * gap; x < camera.x + viewW / 2; x += gap) { context.beginPath(); context.moveTo(x, camera.y - viewH / 2); context.lineTo(x, camera.y + viewH / 2); context.stroke() }
  for (let y = Math.floor((camera.y - viewH / 2) / gap) * gap; y < camera.y + viewH / 2; y += gap) { context.beginPath(); context.moveTo(camera.x - viewW / 2, y); context.lineTo(camera.x + viewW / 2, y); context.stroke() }
}
function drawCell(cell: { x: number; y: number; mass: number }, player: PublicPlayer, isMe: boolean) {
  const radius = Math.sqrt(cell.mass) * 4
  context.beginPath(); context.arc(cell.x, cell.y, radius, 0, Math.PI * 2); context.fillStyle = player.color; context.fill(); context.lineWidth = isMe ? 5 : 3; context.strokeStyle = isMe ? '#fff6cc' : 'rgba(255,255,255,.7)'; context.stroke()
  if (radius > 24) { context.fillStyle = '#102039'; context.font = `700 ${Math.max(13, radius / 2.7)}px system-ui`; context.textAlign = 'center'; context.fillText(player.name, cell.x, cell.y + 5) }
}
connect(); draw()
