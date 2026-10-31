// server.js — Brawl Zone (HTTP + WS + Salas X1 + Tunnel)
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT) || 5000;
const USE_TUNNEL = process.env.LT_ENABLED === '1';

// ============ ESTADO ============
const players = {};   // uid -> dados
const sockets = {};   // uid -> ws
const rooms   = {};   // id  -> { senha, criador, jogadores, started, criado }

// ============ HTTP (serve o jogo + API X1) ============
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // ----- API Sala X1 -----
  if (p === '/api/x1/criar' && req.method === 'POST') {
    return readJson(req, d => {
      const id = String(d.id || '').toUpperCase().trim();
      if (!id || !d.senha) return json(res, { ok: false, msg: 'Preencha ID e senha' });
      if (rooms[id]) return json(res, { ok: false, msg: 'ID já existe' });
      rooms[id] = {
        senha: d.senha, criador: d.playerId,
        jogadores: { [d.playerId]: { nome: d.nome, skin: d.skin || 0 } },
        started: false, criado: Date.now()
      };
      console.log(`[X1] Sala ${id} criada por ${d.nome}`);
      json(res, { ok: true, id });
    });
  }

  if (p === '/api/x1/entrar' && req.method === 'POST') {
    return readJson(req, d => {
      const id = String(d.id || '').toUpperCase().trim();
      const r = rooms[id];
      if (!r) return json(res, { ok: false, msg: 'Sala não existe' });
      if (r.senha !== d.senha) return json(res, { ok: false, msg: 'Senha incorreta' });
      if (Object.keys(r.jogadores).length >= 2 && !r.jogadores[d.playerId])
        return json(res, { ok: false, msg: 'Sala cheia' });
      r.jogadores[d.playerId] = { nome: d.nome, skin: d.skin || 0 };
      console.log(`[X1] ${d.nome} entrou na sala ${id}`);
      json(res, { ok: true, id });
    });
  }

  if (p === '/api/x1/status' && req.method === 'GET') {
    const id = String(url.searchParams.get('id') || '').toUpperCase();
    const r = rooms[id];
    if (!r) return json(res, { ok: false, msg: 'Sala não existe' });
    return json(res, {
      ok: true, id, criador: r.criador, started: r.started,
      count: Object.keys(r.jogadores).length,
      jogadores: Object.entries(r.jogadores).map(([uid, j]) => ({ uid, ...j }))
    });
  }

  if (p === '/api/x1/start' && req.method === 'POST') {
    return readJson(req, d => {
      const id = String(d.id || '').toUpperCase();
      const r = rooms[id];
      if (!r) return json(res, { ok: false, msg: 'Sala não existe' });
      if (r.criador !== d.playerId) return json(res, { ok: false, msg: 'Só o criador pode iniciar' });
      if (Object.keys(r.jogadores).length < 2) return json(res, { ok: false, msg: 'Aguardando 2 jogadores' });
      r.started = true;
      for (const uid of Object.keys(r.jogadores)) {
        if (sockets[uid] && sockets[uid].readyState === 1)
          sockets[uid].send(JSON.stringify({ type: 'x1-start', roomId: id }));
      }
      console.log(`[X1] Sala ${id} INICIADA`);
      json(res, { ok: true });
    });
  }

  // ----- Arquivos estáticos -----
  let file = p === '/' ? '/jogo.html' : p;
  file = decodeURIComponent(file);
  const full = path.normalize(path.join(__dirname, file));
  if (!full.startsWith(__dirname)) { res.writeHead(403); return res.end('Forbidden'); }

  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404 ' + file); }
    const mime = {
      '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.json': 'application/json',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
    }[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

function json(res, obj) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function readJson(req, cb) { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch { cb({}); } }); }

// ============ WEBSOCKET ============
const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  let pid = null;

  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch { return; }

    if (d.type === 'register') {
      pid = d.id;
      players[pid] = {
        uid: pid, name: d.name || 'Jogador', pp: d.pp || 0, coins: d.coins || 0,
        hero: d.hero || 0, heroName: d.heroName || '', color: d.color || '#7c5cd6',
        online: true, status: d.status || 'No Lobby', lastSeen: Date.now()
      };
      sockets[pid] = ws;
      console.log(`[WS] Conectou: ${d.name} (${pid})`);
      broadcastRanking();
    }
    else if (d.type === 'update' && pid && players[pid]) {
      Object.assign(players[pid], d.payload || {});
      players[pid].lastSeen = Date.now();
      broadcastRanking();
    }
    else if (d.type === 'getRanking') {
      ws.send(JSON.stringify({ type: 'ranking', list: Object.values(players) }));
    }
    else if (d.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
  });

  ws.on('close', () => {
    if (pid && players[pid]) {
      players[pid].online = false;
      players[pid].status = 'offline';
      players[pid].lastSeen = Date.now();
      broadcastRanking();
    }
    if (pid) delete sockets[pid];
    console.log(`[WS] Desconectou: ${pid}`);
  });
});

function broadcastRanking() {
  const msg = JSON.stringify({ type: 'ranking', list: Object.values(players) });
  for (const id in sockets) if (sockets[id].readyState === 1) sockets[id].send(msg);
}

// Marca inativos como offline (heartbeat)
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const uid in players) {
    if (players[uid].online && now - players[uid].lastSeen > 90000) {
      players[uid].online = false; players[uid].status = 'offline'; changed = true;
    }
  }
  if (changed) broadcastRanking();
}, 30000);

// Limpa salas X1 antigas (>1h)
setInterval(() => {
  const now = Date.now();
  for (const id in rooms) if (now - rooms[id].criado > 3600e3) delete rooms[id];
}, 60000);

// ============ START ============
server.listen(PORT, () => {
  console.log('══════════════════════════════════════════════');
  console.log('🎮 Brawl Zone Server');
  console.log(`📍 Local: http://localhost:${PORT}`);
  console.log('══════════════════════════════════════════════');

  if (USE_TUNNEL) {
    try {
      const localtunnel = require('localtunnel');
      localtunnel({ port: PORT }).then(t => {
        console.log('🌐 ONLINE: ' + t.url);
        console.log('   Compartilhe este link!');
        console.log('══════════════════════════════════════════════');
        t.on('close', () => console.log('Tunnel fechado'));
      }).catch(e => console.error('Tunnel erro:', e.message));
    } catch (e) {
      console.error('❌ localtunnel não instalado. Rode: npm i -D localtunnel');
    }
  } else {
    console.log('💡 Acesso online: npm run tunnel');
    console.log('══════════════════════════════════════════════');
  }
});