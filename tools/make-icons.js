// 앱 아이콘(PNG)을 만든다. 이미지 라이브러리 없이 헤드리스 Chrome의 캔버스로 그려서 public/icons/ 에 저장한다.
// 실행: node tools/make-icons.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능)
// 만드는 것: 앱 아이콘 192/512, 마스크 가능(maskable) 512, iOS 홈 화면 180, 알림 배지 96(흰색 단색),
//           위장 알림용 아이콘 3종(학습 도우미/문서 편집기/계산기: 특정 회사 로고를 흉내 내지 않는 단순한 그림)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9400 + Math.floor(Math.random() * 90);
const OUT = path.join(__dirname, '..', 'public', 'icons');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));

// 브라우저 안에서 실행되는 그리기 코드
const DRAW = `(() => {
  const BUBBLE = new Path2D('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'); // 말풍선 (24x24 기준)
  const rr = (g, x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, r); };
  function canvas(size) { const c = document.createElement('canvas'); c.width = c.height = size; return [c, c.getContext('2d')]; }

  // 앱 아이콘: 가지색 바탕 + 램프색 말풍선 + 재생 삼각형. safe = 마스크 영역(바깥 10%는 잘릴 수 있어서 그림을 안쪽에 둔다)
  function app(size, { maskable }) {
    const [c, g] = canvas(size);
    const grad = g.createLinearGradient(0, 0, size, size); grad.addColorStop(0, '#2b2150'); grad.addColorStop(1, '#1b1530');
    g.fillStyle = grad;
    if (maskable) g.fillRect(0, 0, size, size); else { rr(g, 0, 0, size, size, size * 0.22); g.fill(); }
    const glyph = size * (maskable ? 0.5 : 0.62), off = (size - glyph) / 2;
    g.save(); g.translate(off, off - glyph * 0.02); g.scale(glyph / 24, glyph / 24);
    g.fillStyle = '#ffb84d'; g.fill(BUBBLE);
    g.fillStyle = '#1b1530'; g.beginPath(); g.moveTo(9.4, 6.2); g.lineTo(15.6, 10); g.lineTo(9.4, 13.8); g.closePath(); g.fill(); // 재생 삼각형
    g.restore();
    return c.toDataURL('image/png');
  }
  // 알림 배지: 안드로이드 상태 표시줄용. 흰색 모양만 있고 나머지는 투명해야 한다
  function badge(size) {
    const [c, g] = canvas(size); const glyph = size * 0.8, off = (size - glyph) / 2;
    g.save(); g.translate(off, off); g.scale(glyph / 24, glyph / 24); g.fillStyle = '#fff'; g.fill(BUBBLE); g.restore();
    return c.toDataURL('image/png');
  }
  // 위장 아이콘: 특정 서비스를 닮지 않은 일반적인 그림
  function spoof(kind, size) {
    const [c, g] = canvas(size); const u = size / 100;
    const bg = { study: '#2f6fed', docs: '#3a7bd5', calc: '#4b5563' }[kind];
    g.fillStyle = bg; rr(g, 0, 0, size, size, size * 0.22); g.fill();
    g.fillStyle = '#fff';
    if (kind === 'study') { // 펼친 책
      g.beginPath(); g.moveTo(50 * u, 30 * u); g.quadraticCurveTo(32 * u, 22 * u, 18 * u, 26 * u); g.lineTo(18 * u, 72 * u); g.quadraticCurveTo(32 * u, 68 * u, 50 * u, 76 * u); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(50 * u, 30 * u); g.quadraticCurveTo(68 * u, 22 * u, 82 * u, 26 * u); g.lineTo(82 * u, 72 * u); g.quadraticCurveTo(68 * u, 68 * u, 50 * u, 76 * u); g.closePath(); g.globalAlpha = 0.85; g.fill(); g.globalAlpha = 1;
    } else if (kind === 'docs') { // 글줄이 있는 문서
      rr(g, 28 * u, 18 * u, 44 * u, 64 * u, 5 * u); g.fill();
      g.fillStyle = bg; for (const y of [34, 46, 58]) { rr(g, 36 * u, y * u, 28 * u, 5 * u, 2.5 * u); g.fill(); } rr(g, 36 * u, 70 * u, 16 * u, 5 * u, 2.5 * u); g.fill();
    } else { // 계산기
      rr(g, 26 * u, 16 * u, 48 * u, 68 * u, 6 * u); g.fill();
      g.fillStyle = bg; rr(g, 32 * u, 22 * u, 36 * u, 14 * u, 3 * u); g.fill();
      g.fillStyle = bg; for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) { rr(g, (33 + q * 12.5) * u, (44 + r * 12.5) * u, 9 * u, 9 * u, 2 * u); g.fill(); }
    }
    return c.toDataURL('image/png');
  }
  return {
    'icon-192.png': app(192, { maskable: false }), 'icon-512.png': app(512, { maskable: false }),
    'icon-maskable-512.png': app(512, { maskable: true }), 'apple-touch-icon.png': app(180, { maskable: true }),
    'badge-96.png': badge(96),
    'spoof-study.png': spoof('study', 192), 'spoof-docs.png': spoof('docs', 192), 'spoof-calc.png': spoof('calc', 192),
  };
})()`;

(async () => {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  try {
    await wait(2500);
    const tab = (await getJson(`http://localhost:${CDP_PORT}/json`)).find((t) => t.type === 'page');
    const cdp = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((r) => cdp.on('open', r));
    const res = await new Promise((ok) => {
      cdp.on('message', (d) => { const m = JSON.parse(d); if (m.id === 1) ok(m); });
      cdp.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: DRAW, returnByValue: true } }));
    });
    if (res.result.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description);
    fs.mkdirSync(OUT, { recursive: true });
    for (const [name, url] of Object.entries(res.result.result.value)) {
      const buf = Buffer.from(url.split(',')[1], 'base64');
      fs.writeFileSync(path.join(OUT, name), buf);
      console.log(name.padEnd(24), buf.length, 'bytes');
    }
    cdp.close();
  } finally { chrome.kill(); try { require("child_process").execSync(`taskkill /pid ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch {} try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
