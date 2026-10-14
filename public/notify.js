/* ================= 알림 설정 · 알림 위장 · 푸시 ================= */
// 앱이 닫혀 있거나 화면을 안 보고 있을 때는 서버가 푸시 알림을 보낸다 (iPhone은 홈 화면에 설치한 앱에서만).
// 위장: 알림의 이름·내용·아이콘(서버가 만든다)과 탭 제목·아이콘(여기서 바꾼다)을 평범한 것으로 바꾼다.
// 구독마다 설정이 따로 서버에 저장되므로 폰은 위장, PC는 평소대로 처럼 기기별로 다르게 쓸 수 있다.
let notifPrefs = { dm: true, ding: true, spoof: 'off', tab: true, open: false }; // open: 방이 열리면(빈 방에 첫 사람이 들어오면) 알림
try { Object.assign(notifPrefs, JSON.parse(get('notifPrefs') || '{}')); } catch {}
let spoofs = {}, vapidKey = '';
const baseTitle = document.title, baseIconEl = document.querySelector('link[rel=icon]'), baseIcon = baseIconEl?.getAttribute('href');
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const savePrefs = () => set('notifPrefs', JSON.stringify(notifPrefs));

// ---- 탭 제목·아이콘 ----
function setIdentity(title, icon) { document.title = title; baseIconEl?.setAttribute('type', /^data:image\/svg/.test(icon) ? 'image/svg+xml' : 'image/png'); baseIconEl?.setAttribute('href', icon); }
// 우선순위: 알림 위장의 탭 제목·아이콘 > 앱 로고 위장(logo.js) > 원래 모습
function applyTabIdentity() {
  const sp = spoofs[notifPrefs.spoof], d = logoNow();
  if (notifPrefs.tab && sp?.tab) setIdentity(sp.tab, sp.icon); else if (d) setIdentity(d.title, d.icon); else setIdentity(baseTitle, baseIcon);
  paintLogo(d);
}
// 패닉 중에는 위장 설정이 없어도 평범한 탭으로 보이게 한다 (패닉이 막 시작되는 중이라 saverOn 은 아직 false 다)
function panicIdentity(on) {
  if (!on) return applyTabIdentity();
  const sp = spoofs[notifPrefs.spoof], d = logoNow(true);
  setIdentity(sp?.tab || d?.title || '새 탭', sp?.tab ? sp.icon : d?.icon || baseIcon);
  paintLogo(d);
}

// ---- 푸시 구독 ----
async function pushSend() { // 현재 설정으로 서버의 구독 정보를 갱신
  const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  if (sub) send({ t: 'push-sub', sub: sub.toJSON(), prefs: { dm: notifPrefs.dm, spoof: notifPrefs.spoof, open: notifPrefs.open } });
  return !!sub;
}
async function enablePush() {
  if (!pushSupported()) return '이 브라우저나 접속 방식에서는 알림을 쓸 수 없어요. (iPhone은 "홈 화면에 추가"한 앱에서만 가능하고, https 주소여야 해요)';
  if ((await Notification.requestPermission()) !== 'granted') return '알림이 차단돼 있어요. 주소창 왼쪽의 자물쇠 → 알림을 "허용"으로 바꿔 주세요.';
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  try {
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(vapidKey) });
  } catch (e) { // 서버의 푸시 키가 바뀌었으면 예전 구독을 지우고 다시 만든다
    await sub?.unsubscribe();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(vapidKey) });
  }
  send({ t: 'push-sub', sub: sub.toJSON(), prefs: { dm: notifPrefs.dm, spoof: notifPrefs.spoof, open: notifPrefs.open } });
  set('pushOn', '1');
  return '';
}
async function disablePush() {
  const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  if (sub) { send({ t: 'push-unsub', endpoint: sub.endpoint }); await sub.unsubscribe(); }
  set('pushOn', '');
}

// ---- 설정 창 ----
function renderNotify(note) {
  $('#dmOn').checked = notifPrefs.dm;
  $('#openOn').checked = !!notifPrefs.open;
  $('#dingOn').checked = notifPrefs.ding !== false;
  $('#tabSpoof').checked = notifPrefs.tab;
  $('#spoofSel').value = notifPrefs.spoof;
  $('#pushOn').checked = !!get('pushOn') && pushSupported() && Notification.permission === 'granted';
  $('#pushOn').disabled = !pushSupported();
  $('#pushTest').disabled = !$('#pushOn').checked;
  $('#pushNote').textContent = note ?? (pushSupported() ? '' : '이 브라우저나 접속 방식에서는 알림을 쓸 수 없어요. iPhone은 "앱으로 설치"한 뒤 앱에서 켜 주세요. https 주소여야 해요.');
  // 미리보기: 실제로 어떻게 보일지
  const sp = spoofs[notifPrefs.spoof] || {}, prev = $('#spoofPrev');
  prev.replaceChildren(
    el('img', { src: sp.icon || '/icons/icon-192.png', alt: '', width: 40, height: 40 }),
    el('div', {}, el('b', { textContent: sp.title || '하늘' }), el('span', { textContent: sp.body || '오늘 같이 영상 볼래?' }),
      sp.tab && notifPrefs.tab ? el('span', { textContent: ` · 탭 제목: ${sp.tab}`, style: 'display:block;font-size:12px' }) : ''));
}
$('#pushOn').onchange = async (e) => {
  try {
    if (e.target.checked) { const err = await enablePush(); renderNotify(err || '이 기기에서 알림을 받아요. "테스트 알림 보내기"로 확인해 보세요.'); }
    else { await disablePush(); renderNotify('알림을 껐어요.'); }
  } catch (err) { console.warn(err); renderNotify('알림을 켜지 못했어요. 잠시 뒤 다시 시도해 주세요.'); }
};
$('#openOn').onchange = (e) => { notifPrefs.open = e.target.checked; savePrefs(); pushSend().then((ok) => { if (!ok && notifPrefs.open) renderNotify('먼저 위의 "이 기기에서 알림 받기"를 켜 주세요. 그러면 방이 열릴 때 알림이 와요.'); }); };
$('#dmOn').onchange = (e) => { notifPrefs.dm = e.target.checked; savePrefs(); pushSend(); };
$('#dingOn').onchange = (e) => { notifPrefs.ding = e.target.checked; savePrefs(); };
$('#tabSpoof').onchange = (e) => { notifPrefs.tab = e.target.checked; savePrefs(); applyTabIdentity(); renderNotify(); };
$('#spoofSel').onchange = (e) => { notifPrefs.spoof = e.target.value; savePrefs(); applyTabIdentity(); pushSend(); renderNotify(); };
$('#pushTest').onclick = () => { send({ t: 'push-test' }); renderNotify('테스트 알림을 보냈어요. 잠시 뒤 알림이 뜨는지 보세요.'); };

function notifyInit(m) {
  $('#notifSec').hidden = !m.me.uid; // 쪽지 알림은 로그인한 사람만
  spoofs = m.spoofs || {}; vapidKey = m.vapid || '';
  const sel = $('#spoofSel');
  if (!sel.options.length) for (const [k, v] of Object.entries(spoofs)) sel.append(el('option', { value: k, textContent: v.label }));
  if (!spoofs[notifPrefs.spoof]) notifPrefs.spoof = 'off';
  applyTabIdentity(); renderNotify();
  send({ t: 'vis', v: !document.hidden });
  if (m.me.uid && get('pushOn') && pushSupported() && Notification.permission === 'granted') pushSend().then((ok) => ok || enablePush().then(() => renderNotify())).catch(() => {});
}
/* ---------- 알림 권한 미리 받기 ----------
   로그인한 사람이 들어오면(그룹방 안내가 끝난 뒤) 한 번 안내 카드를 띄운다. "알림 켜기"를 누르면 그 클릭 안에서 바로 브라우저의 허용 창을 띄운다.
   "나중에"는 3일 뒤에 다시 묻고, 브라우저에서 이미 차단했거나 허용했으면 묻지 않는다. 푸시를 못 쓰는 환경(iPhone의 Safari 탭 등)에서도 묻지 않는다. */
const ASK_SNOOZE = 3 * 86400e3;
const notifAskNeeded = () => !tourDirect() && !!meUid && pushSupported() && Notification.permission === 'default' && !get('pushOn') && !(Number(get('notifAsk')) > Date.now()) && !saverOn;
function notifAskSoon(tries = 0) {
  setTimeout(() => {
    if (!notifAskNeeded()) return;
    if (tourOn || document.hidden) return tries < 12 && notifAskSoon(tries + 1); // 안내 중이거나 화면을 안 보고 있으면 잠시 뒤에 다시
    $('#naMsg').textContent = ''; $('#notifAsk').hidden = false; $('#naOn').focus({ preventScroll: true });
  }, 2500);
}
const notifAskClose = (snooze) => { $('#notifAsk').hidden = true; if (snooze) set('notifAsk', String(Date.now() + ASK_SNOOZE)); };
$('#naLater').onclick = () => notifAskClose(true);
$('#naOn').onclick = async () => {
  const btn = $('#naOn'), msg = $('#naMsg'); btn.disabled = true; msg.textContent = '브라우저에서 "허용"을 눌러 주세요…';
  try {
    const err = await enablePush(); // 이 클릭 안에서 Notification.requestPermission() 을 바로 부른다
    if (err) { msg.textContent = err; if (Notification.permission !== 'denied') set('notifAsk', String(Date.now() + ASK_SNOOZE)); btn.disabled = false; btn.textContent = '다시 해 보기'; return; }
    renderNotify('이 기기에서 알림을 받아요. "테스트 알림 보내기"로 확인해 보세요.'); notifAskClose(false);
  } catch (e) { console.warn(e); msg.textContent = '알림을 켜지 못했어요. 설정 → 알림에서 다시 켜 볼 수 있어요.'; set('notifAsk', String(Date.now() + ASK_SNOOZE)); btn.disabled = false; btn.textContent = '다시 해 보기'; }
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#notifAsk').hidden) notifAskClose(true); });

// 화면을 보고 있는지 서버에 알린다: 보고 있으면 푸시 대신 앱 안에서 알려 주면 되기 때문
document.addEventListener('visibilitychange', () => joined && send({ t: 'vis', v: !document.hidden }));
