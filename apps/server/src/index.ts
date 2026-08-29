import 'dotenv/config'
import { createServer } from 'node:http'
import { createClient } from '@supabase/supabase-js'
import { Server } from 'socket.io'
import { GAME } from '@cell-clash/shared'
import { Arena } from './arena.js'

const port = Number(process.env.PORT ?? 3001)
const authRequired = process.env.AUTH_REQUIRED === 'true'
const allowedOrigins = (process.env.CLIENT_ORIGIN ?? '').split(',').map((value) => value.trim()).filter(Boolean)
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } }) : null
if (authRequired && !supabase) throw new Error('AUTH_REQUIRED needs SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY')

const httpServer = createServer((request, response) => {
  if (request.url === '/healthz') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, players: arena.players.size })); return }
  response.writeHead(404); response.end()
})
const io = new Server(httpServer, { cors: { origin: allowedOrigins.length ? allowedOrigins : true, methods: ['GET', 'POST'] } })
const arena = new Arena()
const lastInput = new Map<string, number>()

io.use(async (socket, next) => {
  const token = typeof socket.handshake.auth.token === 'string' ? socket.handshake.auth.token : null
  if (!authRequired) return next()
  if (!token || !supabase) return next(new Error('Authentication required'))
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return next(new Error('Invalid session'))
  socket.data.userId = data.user.id
  next()
})

function broadcastLobby() { io.emit('lobby', arena.lobbyState()) }
function reject(socket: { emit: (event: string, payload: unknown) => void }, code: string) { socket.emit('gameError', { code }) }

io.on('connection', (socket) => {
  socket.on('joinArena', (payload: { name?: unknown }) => {
    const error = arena.join(socket.id, payload?.name)
    if (error) return reject(socket, error)
    socket.emit('joined', { id: socket.id, maxPlayers: GAME.lobbyMax })
    broadcastLobby()
  })
  socket.on('setMode', (mode: unknown) => { const error = arena.setMode(socket.id, mode); if (error) reject(socket, error); else broadcastLobby() })
  socket.on('startMatch', () => { const error = arena.start(socket.id); if (error) reject(socket, error); else broadcastLobby() })
  socket.on('input', (vector: unknown) => {
    const now = Date.now(); if (now - (lastInput.get(socket.id) ?? 0) < GAME.inputRateLimitMs) return
    lastInput.set(socket.id, now); arena.input(socket.id, vector)
  })
  socket.on('split', () => arena.split(socket.id))
  socket.on('eject', () => arena.eject(socket.id))
  socket.on('disconnect', () => { lastInput.delete(socket.id); arena.leave(socket.id); broadcastLobby() })
})

setInterval(() => { const result = arena.update(); io.emit('snapshot', arena.snapshot()); if (result) io.emit('matchFinished', result); broadcastLobby() }, 1000 / GAME.tickRate)
httpServer.listen(port, () => console.log(`Cell Clash server listening on :${port}`))
