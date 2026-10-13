// 웹앱(PWA) 점검: 설치 가능한지(Chrome의 설치 조건), 서비스 워커가 앱 껍데기를 저장하는지,
// 인터넷이 끊기거나 서버가 꺼졌을 때 앱이 '서버가 꺼졌습니다' 안내를 보여 주는지.
// 실행: node tools/pwa-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 4300 + Math.floor(Math.random() * 90), CDP_PORT = 9900 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));

(async () => {
  const state = path.join(os.tmpdir(), `pwa-${Date.now()}.json`);
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, STATE_FILE: state, CONFIG_FILE: require('path').join(require('os').tmpdir(), 'no-such-config.env') }, stdio: 'ignore' });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let failed = 0;
  const check = (ok, msg) => { console.log((ok ? '  통과 ' : '  실패 ') + msg); if (!ok) failed++; };
  try {
    await wait(2500);
    const tab = (await getJson(`http://localhost:${CDP_PORT}/json`)).find((t) => t.type === 'page');
    const cdp = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((r) => cdp.on('open', r));
    let id = 0; const pending = new Map();
    cdp.on('message', (d) => { const m = JSON.parse(d); pending.get(m.id)?.(m); });
    const call = (method, params = {}) => new Promise((ok) => { const i = ++id; pending.set(i, ok); cdp.send(JSON.stringify({ id: i, method, params })); });
    const js = async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
    const open = async () => { await call('Page.navigate', { url: `http://localhost:${PORT}/` }); await wait(1800); };
    await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 800, height: 700, deviceScaleFactor: 1, mobile: false });

    console.log('설치 조건');
    await open();
    const sw = await js(`navigator.serviceWorker.ready.then(r => r.active?.state)`);
    check(sw === 'activated', `서비스 워커가 활성화됨 (${sw})`);
    const man = (await call('Page.getAppManifest')).result;
    const m = man.data ? JSON.parse(man.data) : {};
    check(!man.errors?.length && m.display === 'standalone', `매니페스트 오류 없음, display=${m.display}${man.errors?.length ? ' 오류: ' + man.errors.map((e) => e.message).join(' / ') : ''}`);
    check(m.icons?.some((i) => i.sizes === '192x192') && m.icons?.some((i) => i.sizes === '512x512') && m.icons?.some((i) => i.purpose === 'maskable'), '192/512 아이콘과 maskable 아이콘이 있음');
    const inst = (await call('Page.getInstallabilityErrors')).result?.installabilityErrors || [];
    check(inst.length === 0, `Chrome 설치 조건 충족 (미충족 ${inst.length}건${inst.length ? ': ' + inst.map((e) => e.errorId).join(',') : ''})`);
    const cached = await js(`caches.keys().then(async ks => (await Promise.all(ks.map(async k => (await (await caches.open(k)).keys()).length)))[0])`);
    check(cached >= 10, `앱 껍데기 파일이 저장됨 (${cached}개)`);
    const icons = await js(`Promise.all(['/icons/icon-192.png','/icons/icon-512.png','/icons/icon-maskable-512.png','/icons/apple-touch-icon.png','/icons/badge-96.png'].map(u => fetch(u).then(r => r.ok && r.headers.get('content-type') === 'image/png')))`);
    check(icons.every(Boolean), '모든 아이콘이 image/png로 내려감');
    check(await js(`document.querySelector('link[rel=manifest]') && document.querySelector('link[rel=apple-touch-icon]') && document.querySelector('meta[name=apple-mobile-web-app-capable]') ? true : false`), '매니페스트·애플 아이콘 링크가 head에 있음');
    check((await js(`document.querySelector('#installNote').textContent`)).length > 5, `설정 창에 설치 안내 문구 ("${await js(`document.querySelector('#installNote').textContent`)}")`);

    console.log('인터넷이 끊겼을 때 (서버는 켜져 있음)');
    await call('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await open();
    check(await js(`document.querySelector('.end h1')?.textContent`) === '인터넷 연결이 끊겼어요', '캐시된 앱이 떠서 "인터넷 연결이 끊겼어요" 안내를 보여 줌 (서버 탓이 아님)');
    await call('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

    console.log('서버가 꺼졌을 때');
    srv.kill(); await wait(800);
    await open();
    check(await js(`document.querySelector('.end h1')?.textContent`) === '서버가 꺼졌습니다', '서비스 워커가 앱을 띄우고 "서버가 꺼졌습니다" 안내가 바로 뜸');
    cdp.close();
  } finally { chrome.kill(); try { require("child_process").execSync(`taskkill /pid ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch {} try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}  srv.kill(); fs.rmSync(state, { force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
