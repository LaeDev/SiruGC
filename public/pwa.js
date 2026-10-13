/* ================= 웹앱(PWA): 서비스 워커 등록, 설치 안내 ================= */
let installEvt = null; // 브라우저가 "설치할 수 있어요"라고 알려 준 이벤트
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js?v=' + BUILD).catch((e) => console.warn('서비스 워커를 등록하지 못했어요', e)));
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.t === 'sw-updated' && e.data.build !== BUILD) offerUpdate(e.data.build); }); // 새 서비스 워커가 자리 잡았는데 이 화면이 옛 버전
}
// 최신 화면으로 새로고침: 서비스 워커와 저장된 앱 파일을 지우고 처음부터 다시 받는다 (로그인·설정은 그대로)
async function forceRefresh() {
  try { for (const r of (await navigator.serviceWorker?.getRegistrations?.()) || []) await r.unregister(); } catch {}
  try { for (const k of await caches.keys()) await caches.delete(k); } catch {}
  location.replace(location.pathname + '?r=' + Date.now());
}
// 열어 둔 화면(특히 앱으로 설치해 메모리에 계속 떠 있는 것)이 옛 버전인지, 화면을 다시 볼 때마다 서버에 물어본다
let buildAsked = 0;
async function checkBuild() {
  if (!BUILD || Date.now() - buildAsked < 30000) return;
  buildAsked = Date.now();
  try {
    navigator.serviceWorker?.getRegistration?.().then((r) => r?.update?.()).catch(() => {});
    const j = await (await fetch('/build', { cache: 'no-store' })).json();
    if (j.build && j.build !== BUILD) offerUpdate(j.build);
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkBuild(); });
addEventListener('pageshow', checkBuild);
setInterval(checkBuild, 5 * 60 * 1000);
$('#forceRefresh').onclick = forceRefresh;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; renderInstall(); });
addEventListener('appinstalled', () => { installEvt = null; renderInstall(); });
matchMedia('(display-mode: standalone)').addEventListener('change', renderInstall);

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1); // iPadOS는 Mac처럼 보이지만 터치가 된다
function renderInstall() {
  const note = $('#installNote'), btn = $('#installBtn');
  btn.hidden = !installEvt;
  if (isStandalone()) note.textContent = '지금 앱으로 실행 중이에요. 쪽지 알림도 앱에서 받을 수 있어요.';
  else if (!window.isSecureContext) note.textContent = '앱 설치와 알림은 https 주소(또는 localhost)에서만 쓸 수 있어요.';
  else if (installEvt) note.textContent = '바탕화면/홈 화면에 앱으로 설치할 수 있어요. 설치하면 주소창 없이 열리고 알림도 받을 수 있어요.';
  else if (isIos()) note.textContent = '이 기기에서는 주소창의 앱 설치 버튼이 없어요. 아래 "iPhone·iPad" 순서대로 Safari의 공유 메뉴에서 홈 화면에 추가하세요. 알림은 홈 화면에 추가한 앱에서만 받을 수 있어요.';
  else note.textContent = '이 브라우저에서는 주소창 오른쪽의 설치 아이콘이나 메뉴의 "앱 설치"로 설치할 수 있어요. 이미 설치했다면 앱으로 열어 보세요.';
}
// 쓰고 있는 기기의 설치 방법만 처음부터 펼쳐 둔다 (이미 앱으로 실행 중이면 모두 접어 둔다)
{
  const ua = navigator.userAgent, mine = isIos() ? 'gIos' : /SamsungBrowser/i.test(ua) ? 'gSam' : /Android/i.test(ua) ? 'gAnd' : '';
  if (mine && !isStandalone()) {
    $('#' + mine).open = true;
    const others = el('details', { className: 'others sub' }, el('summary', { textContent: '다른 기기 설치 방법' }));
    for (const id of ['gIos', 'gAnd', 'gSam']) if (id !== mine) others.append($('#' + id));
    $('#' + mine).after(others);
  }
}
$('#installBtn').onclick = async () => {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice;
  installEvt = null; renderInstall();
};
renderInstall();
