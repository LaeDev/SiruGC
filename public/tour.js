/* ================= 처음 쓰는 사람을 위한 안내 (그룹방 / 쪽지) ================= */
// 카드 안내(제목·설명·다음/건너뛰기)에 화면의 해당 버튼을 밝게 비춰 주는 하이라이트를 겸한다. 그룹방과 쪽지는 따로이고, 각각 처음 한 번만 뜬다.
// 끝내거나 건너뛰면 이 기기에 기록해서 다시 안 뜨고, 설정 → 앱 설치·정보 → 도움말에서 다시 볼 수 있다.
// 주소에 ?step=profile 이 있는 직접 열기(자동 점검 도구)와 패닉 화면 중에는 띄우지 않는다.
const TOURS = {
  room: [
    { title: '그룹방에 오신 걸 환영해요', body: '같이 영상을 보고, 이야기하고, 화면을 나누는 방이에요. 처음이라면 1분만 둘러보세요.' },
    { target: '#tab-queue', title: '같이 볼 영상은 대기열에', body: '유튜브 링크를 대기열에 올리면 모두 같은 장면을 봐요. 올리는 건 호스트가 허락한 사람만 할 수 있어요.' },
    { target: '#tab-users', title: '참가자와 쪽지', body: '사람을 누르면 쪽지를 보내거나 그 사람의 목소리 크기를 조절할 수 있어요. 호스트는 여기서 대기열 권한도 줘요.' },
    { target: '#voiceBtn', title: '음성과 화면 공유', body: '"음성 참가"를 누르면 서로 이야기할 수 있고, "화면 공유"로 내 화면을 보여 줄 수 있어요.' },
    { target: '#panicBtn', title: '급할 때는 패닉', body: '이 버튼(또는 Esc 두 번)을 누르면 소리와 마이크가 꺼지고 화면이 강의 영상으로 덮여요. 풀려면 화면을 10초 누르고 비밀번호를 넣어요.' },
    { target: '#settingsBtn', title: '설정과 도움말', body: '테마, 알림, 목소리 설정은 여기에 있어요. 이 안내는 설정 → 앱 설치·정보에서 다시 볼 수 있어요.' },
  ],
  dm: [
    { title: '쪽지는 암호화돼요', body: '쪽지는 로그인한 사람끼리 주고받아요. 보내는 순간 내 기기에서 잠겨서, 받는 사람의 기기에서만 열려요. 서버도 내용을 읽을 수 없어요.' },
    { target: '#dmNew', title: '새 쪽지 보내기', body: '"새 쪽지"에서 보낼 사람을 골라요. 지금 접속하지 않은 사람에게도 보낼 수 있고, 상대가 들어오면 받아요.' },
    { title: '정말 암호화되는지 확인하기', body: '대화창 위의 "암호화됨" 버튼을 누르면 안전번호와, 서버에 저장된 쪽지가 어떻게 보이는지 볼 수 있어요. 상대와 안전번호가 같은지 맞춰 보세요.' },
    { title: '새 기기에서는 한 번 열어 줘요', body: '다른 기기에서 처음 쪽지를 열면 계정 비밀번호를 한 번 물어요. 비밀번호를 잊어서 초기화하면 이전 쪽지는 읽을 수 없게 돼요.' },
  ],
};
let tourOn = null, tourI = 0, tourName = '';
const tourDirect = () => new URLSearchParams(location.search).get('step') === 'profile';
const tourSeen = (n) => get('tour:' + n) === '1';
const tourVisible = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; };

function tourMaybe(name) { // 처음이면 띄운다 (이미 다른 안내나 패닉 화면이 떠 있으면 건너뛴다)
  if (tourDirect() || tourOn || saverOn || tourSeen(name)) return;
  if (name === 'dm' && !meUid) return; // 게스트는 쪽지를 못 쓴다
  setTimeout(() => { if (!tourOn && !saverOn && !tourSeen(name)) startTour(name); }, 700);
}
function startTour(name) {
  if (tourOn || !TOURS[name]) return;
  tourName = name; tourI = 0;
  if (name === 'dm') { showTab('dm'); if (typeof dmView === 'function') dmView('list'); }
  const root = el('div', { id: 'tour', role: 'dialog', ariaModal: 'true', ariaLabelledby: 'tourTitle' },
    el('div', { className: 'tour-dim' }), el('div', { className: 'tour-spot' }),
    el('div', { className: 'tour-card' },
      el('small', { id: 'tourStep' }), el('h2', { id: 'tourTitle' }), el('p', { id: 'tourBody' }),
      el('div', { className: 'tour-btns' },
        el('button', { type: 'button', className: 'btn link', id: 'tourSkip', textContent: '건너뛰기', onclick: () => endTour() }),
        el('button', { type: 'button', className: 'btn', id: 'tourPrev', textContent: '이전', onclick: () => tourGo(tourI - 1) }),
        el('button', { type: 'button', className: 'btn primary', id: 'tourNext', onclick: () => tourGo(tourI + 1) }))));
  document.body.append(root); tourOn = root;
  for (const s of ['#app', '#join']) { const e = $(s); if (e) e.inert = true; } // 안내가 떠 있는 동안 뒤 화면은 조작하지 않는다
  tourGo(0);
  addEventListener('resize', tourPlace);
  document.addEventListener('keydown', tourKey, true);
}
function tourGo(i) {
  const steps = TOURS[tourName];
  if (i < 0) return;
  if (i >= steps.length) return endTour();
  tourI = i; const s = steps[i], last = i === steps.length - 1;
  $('#tourStep').textContent = `${i + 1} / ${steps.length}`;
  $('#tourTitle').textContent = s.title; $('#tourBody').textContent = s.body;
  $('#tourPrev').hidden = i === 0; $('#tourNext').textContent = last ? '시작하기' : '다음';
  $('#tourSkip').hidden = last;
  const t = s.target && $(s.target); if (tourVisible(t)) t.scrollIntoView({ block: 'nearest' });
  tourPlace();
  $('#tourNext').focus({ preventScroll: true });
}
function tourPlace() { // 대상이 보이면 그 둘레를 밝게 비추고 카드를 옆(위/아래)에 둔다. 안 보이면 가운데 카드
  if (!tourOn) return;
  const s = TOURS[tourName][tourI], t = s.target && $(s.target), card = $('.tour-card', tourOn), spot = $('.tour-spot', tourOn), dim = $('.tour-dim', tourOn);
  const ok = tourVisible(t);
  spot.hidden = !ok; dim.hidden = ok; tourOn.classList.toggle('plain', !ok);
  card.style.top = card.style.bottom = card.style.left = card.style.transform = '';
  if (!ok) return;
  const r = t.getBoundingClientRect(), pad = 6;
  Object.assign(spot.style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
  const cw = Math.min(340, innerWidth - 24), below = r.top + r.height / 2 < innerHeight / 2;
  card.style.left = Math.max(12, Math.min(innerWidth - cw - 12, r.left + r.width / 2 - cw / 2)) + 'px';
  if (below) card.style.top = Math.min(innerHeight - 12, r.bottom + pad + 14) + 'px'; else card.style.bottom = Math.max(12, innerHeight - r.top + pad + 14) + 'px';
}
function tourKey(e) {
  if (!tourOn) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endTour(); }
  else if (e.key === 'Tab') { // 안내 안에서만 돈다
    const f = [...tourOn.querySelectorAll('button:not([hidden])')], i = f.indexOf(document.activeElement);
    if (!f.length) return;
    e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
  }
}
function endTour() {
  if (!tourOn) return;
  set('tour:' + tourName, '1');
  tourOn.remove(); tourOn = null;
  removeEventListener('resize', tourPlace); document.removeEventListener('keydown', tourKey, true);
  for (const s of ['#app', '#join']) { const e = $(s); if (e && !saverOn) e.inert = false; }
  if (tourName === 'dm') document.activeElement?.blur?.();
  notifAskSoon(); // 안내가 끝났으니 알림 권한도 물어본다
}
// 설정의 "도움말 다시 보기"
for (const [id, name] of [['#helpRoom', 'room'], ['#helpDm', 'dm']]) $(id).onclick = () => { closeSettings(); setTimeout(() => startTour(name), 200); };
