// 로컬 테스트 전용 서버 (배포에는 사용하지 않음). 사용법: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

// 키 파일은 프로젝트 폴더 밖(사용자 홈)에 둔다 → 제출 파일에 키가 섞이지 않음
const os = require('os');
const envFiles = [path.join(os.homedir(), '.exchange_rate.env'), path.join(__dirname, '.env.local')];
if (!envFiles.some((f) => { try { process.loadEnvFile(f); return true; } catch (_) { return false; } })) {
  console.warn('[경고] 키 파일을 읽지 못했습니다. 챗봇은 대체 문구를 표시합니다.');
}

const chat = require('./api/chat.js');
const rates = require('./api/rates.js');
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

// vercel.json 의 headers 와 같은 값 (로컬에서도 같은 조건으로 시험하기 위함)
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

http.createServer((req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/rates') { // 한국은행 ECOS 프록시 (Vercel 함수와 같은 코드를 사용)
    req.query = Object.fromEntries(url.searchParams);
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
    return rates(req, res);
  }

  if (url.pathname === '/api/chat') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 60000) req.destroy(); }); // 대화 기록과 구간 요약이 포함되므로 여유 있게
    req.on('end', () => {
      try { req.body = raw ? JSON.parse(raw) : {}; } catch (_) { req.body = {}; }
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
      chat(req, res);
    });
    return;
  }

  let rel;
  try { rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname); } catch (_) { res.statusCode = 400; return res.end('bad request'); }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (rel.includes('\0') || !file.startsWith(PUBLIC + path.sep)) { res.statusCode = 403; return res.end('forbidden'); } // public 폴더 밖(옆 폴더 포함)은 막는다
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT} 에서 실행 중 (이 컴퓨터에서만 접속 가능, 종료: Ctrl+C)`)); // 같은 네트워크의 다른 기기가 내 키로 챗봇을 쓰지 못하게 한다
