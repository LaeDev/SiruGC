// 옛 화면이 남는 기기를 위한 "최신 화면으로 새로고침"과 새 버전 알아채기를 실제 브라우저로 확인한다.
//  - 첫 화면 맨 아래에 버튼이 늘 보이고(폰에서도 넘치지 않고 터치 크기), 누르면 서비스 워커·저장된 앱 파일을 지우고 새로 받음 (로그인·설정은 그대로)
//  - 서버를 다시 켜지 않고 화면 파일만 바뀌어도 서버가 새 버전 번호를 내려 주고, 열어 둔 화면이 다시 보일 때 "새 버전" 띠가 뜸
//  - 서비스 워커 파일에 버전이 들어가서(파일이 바뀌면 바이트도 바뀜) 브라우저가 새 서비스 워커로 갈아 끼움
// 실행: node tools/refresh-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능)
const { AUTH_ENV } = require('./_auth');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 6400 + Math.floor(Math.random() * 90), CDP_PORT = 9600 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));
const PUBTMP = path.join(os.tmpdir(), 'pub-' + Date.now()), TOUCH = path.join(PUBTMP, 'themes.css'); // 화면 파일을 임시 폴더에 복사해서 그 복사본으로 서버를 띄운다 (진짜 파일은 건드리지 않는다)

(async () => {
  const state = path.join(os.tmpdir(), `refresh-${Date.now()}.json`);
  fs.cpSync(path.join(__dirname, '..', 'public'), PUBTMP, { recursive: true });
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, ...AUTH_ENV, PORT, PUBLIC_DIR: PUBTMP, STATE_FILE: state, CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env') }, stdio: 'ignore' });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  const origBuf = () => fs.readFileSync(TOUCH), base = fs.readFileSync(TOUCH);
  let failed = 0;
  const check = (ok, msg) => { console.log((ok ? '  통과 ' : '  실패 ') + msg); if (!ok) failed++; };
  try {
    await wait(2500);
    const browser = new WebSocket((await getJson(`http://localhost:${CDP_PORT}/json/version`)).webSocketDebuggerUrl);
    await new Promise((r) => browser.on('open', r));
    let id = 0; const pending = new Map();
    browser.on('message', (d) => { const m = JSON.parse(d); pending.get(m.id)?.(m); if (m.method === 'Runtime.exceptionThrown') console.log('  페이지 예외:', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
    const raw = (method, params = {}, sessionId) => new Promise((ok) => { const i = ++id; pending.set(i, ok); browser.send(JSON.stringify({ id: i, method, params, sessionId })); });
    const { result: { browserContextId } } = await raw('Target.createBrowserContext');
    const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank', browserContextId });
    const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
    const call = (m, p) => raw(m, p, sessionId);
    await call('Page.enable'); await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log('JS 오류:', r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
    const until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await wait(200); } return false; };
    const tap = async (sel) => {
      await js(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center' })`); await wait(100);
      const r = await js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width }; })()`);
      if (!r.w) throw new Error('보이지 않음: ' + sel);
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    };
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }); await wait(1800);

    console.log('버튼');
    check(await js(`(() => { const b = document.querySelector('#forceRefresh').getBoundingClientRect(); return b.height >= 44 && b.left >= 0 && b.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; })()`), '첫 화면 맨 아래에 버튼이 보이고, 폰에서 넘치지 않고 터치 크기(44px) 이상');
    check(await js(`document.querySelector('#forceRefresh').textContent.includes('최신 화면으로 새로고침')`), '버튼 이름이 "최신 화면으로 새로고침"');

    console.log('서버가 새 버전 번호를 내려 줌 (서버를 다시 켜지 않아도)');
    check(await until(`navigator.serviceWorker.controller !== null || true`) && await until(`navigator.serviceWorker.getRegistration().then((r) => !!r && !!r.active)`, 8000), '서비스 워커가 등록됨');
    const b0 = (await (await fetch(`http://127.0.0.1:${PORT}/build`)).json()).build;
    check(await js(`document.querySelector('meta[name=build]').content === ${JSON.stringify(b0)}`) && (await (await fetch(`http://127.0.0.1:${PORT}/sw.js`)).text()).includes(`'${b0}'`), '화면과 /build 와 서비스 워커 파일에 같은 버전 번호가 들어 있음');
    fs.utimesSync(TOUCH, new Date(), new Date(Date.now() + 5000)); await wait(3400); // 내용은 그대로, 수정 시각만 바뀐 경우 (git 이 다시 쓰거나 복사만 해도 이렇게 된다)
    check((await (await fetch(`http://127.0.0.1:${PORT}/build`)).json()).build === b0, '파일을 건드리기만 해서(수정 시각만 바뀜) 번호가 안 바뀜 → 최신 화면인데 새 버전 띠가 뜨는 일이 없음');
    fs.writeFileSync(TOUCH, Buffer.concat([base, Buffer.from('\n/* refresh-check */\n')])); await wait(3400); // 화면 파일의 내용이 실제로 바뀐 경우
    const b1 = (await (await fetch(`http://127.0.0.1:${PORT}/build`)).json()).build;
    check(b1 !== b0, '화면 파일의 내용이 바뀌면 서버를 안 껐다 켜도 /build 번호가 바뀜');
    check((await (await fetch(`http://127.0.0.1:${PORT}/sw.js`)).text()).includes(`'${b1}'`), '서비스 워커 파일도 새 번호로 바뀜 (그래서 브라우저가 새 서비스 워커로 갈아 끼움)');
    check(!(await js(`!!document.querySelector('#upd')`)), '(아직 화면은 옛 버전이지만 띠는 화면이 다시 보일 때 뜸)');
    await js(`buildAsked = 0; document.dispatchEvent(new Event('visibilitychange'))`);
    check(await until(`!!document.querySelector('#upd')`, 6000), '열어 둔 화면이 다시 보이면 "새 버전이 나왔어요" 띠가 뜸');
    check(await js(`document.querySelector('#upd button').textContent === '새로고침' && !!document.querySelector('#updLater')`), '띠에 새로고침 버튼과 "나중에"가 있음');
    await tap('#updLater');
    check(await js(`!document.querySelector('#upd') && sessionStorage.getItem('updHide') === ${JSON.stringify(b1)}`), '"나중에"를 누르면 띠가 사라지고 이 버전은 이번 접속 동안 다시 안 띄움');
    await js(`buildAsked = 0; document.dispatchEvent(new Event('visibilitychange'))`); await wait(1500);
    check(!(await js(`!!document.querySelector('#upd')`)), '다시 화면을 봐도 같은 버전으로는 띠가 안 뜸');
    await js(`sessionStorage.removeItem('updHide'); buildAsked = 0; document.dispatchEvent(new Event('visibilitychange'))`); await until(`!!document.querySelector('#upd')`, 6000);

    console.log('누르면');
    await js(`localStorage.setItem('theme', 'nord'); localStorage.setItem('keepme', '1'); caches.open('siru-old-test').then((c) => c.put('/x', new Response('old')))`); await wait(300);
    check(await js(`caches.keys().then((k) => k.includes('siru-old-test'))`), '(준비) 옛 캐시를 하나 만들어 둠');
    await tap('#upd button'); // 띠의 버튼도 같은 일을 한다
    check(await until(`location.search.startsWith('?r=') && document.readyState === 'complete'`, 10000), '누르면 주소에 ?r= 가 붙어 새로 열림');
    await wait(1500);
    check(await js(`caches.keys().then((k) => !k.includes('siru-old-test'))`), '옛 캐시는 지워짐');
    check(await js(`localStorage.getItem('theme') === 'nord' && localStorage.getItem('keepme') === '1'`), '설정(localStorage)은 그대로 남음');
    check(await until(`navigator.serviceWorker.getRegistration().then((r) => !!r)`, 8000), '서비스 워커는 새로 등록됨');
    check(await js(`document.querySelector('meta[name=build]').content === ${JSON.stringify(b1)}`), '새로 받은 화면이 최신 버전 번호를 가짐');
    check(!(await js(`!!document.querySelector('#upd')`)), '새로 받은 화면에는 새 버전 띠가 없음');
    await tap('#forceRefresh');
    check(await until(`location.search.startsWith('?r=')`, 10000), '첫 화면의 버튼도 같은 새로고침을 함');
    console.log('옛 파일을 붙잡는 프록시(NPM 의 "Cache Assets" 처럼) 뒤에서');
    // 실제 사이트에서 확인한 일: NPM 이 .js/.css 를 정적 파일로 보고 우리가 보낸 no-cache 를 무시한 채 한 시간 넘게 붙잡아 둔다. 그걸 흉내 낸다 (.html·/build 는 안 붙잡음)
    const cache = new Map(), PROXY = PORT + 1;
    const proxy = http.createServer((req, res) => {
      const stat = /\.(js|css|wasm|webmanifest)(\?|$)/.test(req.url);
      if (stat && cache.has(req.url)) { const c = cache.get(req.url); res.writeHead(200, c.h); return res.end(c.b); }
      const up = http.request({ host: '127.0.0.1', port: PORT, path: req.url, method: req.method, headers: req.headers }, (r) => {
        const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => {
          const b = Buffer.concat(chunks), h = { ...r.headers };
          if (stat && r.statusCode === 200) { h['cache-control'] = 'max-age=4263'; h.expires = new Date(Date.now() + 4263e3).toUTCString(); cache.set(req.url, { h, b }); }
          res.writeHead(r.statusCode, h); res.end(b);
        });
      });
      req.pipe(up);
    }).listen(PROXY);
    const viaProxy = (p) => new Promise((ok) => http.get({ host: '127.0.0.1', port: PROXY, path: p }, (r) => { const ch = []; r.on('data', (c) => ch.push(c)); r.on('end', () => ok(Buffer.concat(ch).toString('utf8'))); }));
    const html0 = await viaProxy('/'), v0 = (html0.match(/name="build" content="([^"]+)"/) || [])[1];
    check(!!v0 && [...html0.matchAll(/<script[^>]*\ssrc="(\/[^\/"][^"]*)"/g)].every((m) => m[1].endsWith('?v=' + v0)) && /href="\/style\.css\?v=/.test(html0) && /href="\/themes\.css\?v=/.test(html0), '화면이 부르는 모든 스크립트·스타일 주소에 현재 버전(?v=)이 붙어 있음');
    await viaProxy('/themes.css'); await viaProxy('/themes.css?v=' + v0); // 프록시가 두 주소를 모두 붙잡게 한다
    fs.writeFileSync(TOUCH, Buffer.concat([fs.readFileSync(TOUCH), Buffer.from('\n:root{--probe:"새것"}\n')])); await wait(3400); // 화면 파일이 실제로 바뀜
    check((await viaProxy('/themes.css')).includes('--probe') === false, '(대조) 버전이 없는 옛 주소는 프록시가 옛 사본을 계속 내줌 → 이게 옛 화면이 남던 원인');
    check((await viaProxy('/')).match(/name="build" content="([^"]+)"/)[1] !== v0 && (await viaProxy('/')).includes('themes.css?v=') , '화면(html)은 프록시가 안 붙잡아서 새 버전 번호를 내려 줌');
    await call('Page.navigate', { url: 'http://127.0.0.1:' + PROXY + '/' }); await wait(2500);
    check(await js("getComputedStyle(document.documentElement).getPropertyValue('--probe').trim() === '\"새것\"'"), '프록시가 옛 파일을 붙잡고 있어도, 새 화면은 버전이 붙은 새 주소로 새 파일을 받음');
    check(!(await js("!!document.querySelector('#upd')")) && (await js("navigator.serviceWorker.getRegistration().then((r) => r && r.active && r.active.scriptURL.includes('?v=' + BUILD))")), '서비스 워커도 버전 주소로 등록되고, 새로 받은 화면에 "새 버전" 띠가 안 뜸');
    await wait(2500);
    check(!(await js("!!document.querySelector('#upd')")), '조금 지난 뒤에도 띠가 안 뜸 (프록시 뒤에서 최신 화면인데 띠가 계속 뜨던 문제)');
    proxy.close();
    browser.close();
  } catch (e) { console.log('  실패 예외:', e.stack || e); failed++; }
  finally {
    try { fs.rmSync(PUBTMP, { recursive: true, force: true }); } catch {} // 복사본 지우기
    srv.kill(); try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} await wait(500);
    try { fs.rmSync(prof, { recursive: true, force: true }); fs.rmSync(state, { force: true }); } catch {}
  }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
  process.exit(failed ? 1 : 0);
})();
