const { execSync } = require('child_process');

try {
  // Procura processos do node rodando server.js com PID diferente do atual
  const myPid = process.pid;
  const pids = execSync("pgrep -f 'node.*server.js' 2>/dev/null || true")
    .toString()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter(pid => pid && pid !== myPid);

  if (pids.length > 0) {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`Processo antigo encerrado: PID ${pid}`);
      } catch (e) {}
    }
  } else {
    console.log('Nenhum processo antigo em conflito.');
  }
} catch (err) {
  console.log('Nenhum processo para encerrar.');
}
