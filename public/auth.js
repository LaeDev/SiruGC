/* ================= 계정: 로그인·가입, 닉네임 바꾸기, 비밀번호, 계정 관리 ================= */
// 로그인 상태는 이 기기의 토큰(localStorage 'tok')으로 유지한다. 토큰은 서버가 3일마다 새 값으로 바꿔 주고,
// 응답에 새 값이 들어 있으면 바로 저장한다(authPost). 로그인·가입은 서버가 정한 주소(AUTH_HOST)의 https에서만 된다.
let authInfo = { allowed: false, signupOpen: false, host: '' };
let pendingTemp = ''; // 임시 비밀번호로 로그인한 직후, 새 비밀번호를 정하는 동안만 들고 있는다
const loggedIn = () => !!(get('tok') && get('acctName'));
const clearLogin = () => { set('tok', ''); set('acctName', ''); e2eeClear(); }; // 이 기기의 쪽지 키도 같이 지운다
const authDlg = $('#authDlg');

async function authPost(path, body = {}) {
  let r, j = {};
  try {
    r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: get('tok') || undefined, keep: joined ? me : undefined, ...body }) });
    j = await r.json().catch(() => ({}));
  } catch { return { ok: false, error: 'net', msg: '서버에 연결하지 못했어요. 잠시 뒤 다시 해 주세요.' }; }
  if (j.token && r.ok) set('tok', j.token); // 토큰이 새 값으로 바뀌었다
  if (j.error === 'session') clearLogin();
  return { status: r.status, ...j };
}
fetch('/auth/status', { cache: 'no-store' }).then((r) => r.json()).then((i) => { authInfo = i; authUi(); acctUi(); }).catch(() => {});

/* ---------- 입장 화면: 로그인 상태 ---------- */
function authUi() {
  const box = $('#acctBox'), nm = $('#nameIn'), lbl = $('#nameLbl');
  box.replaceChildren();
  if (loggedIn()) {
    nm.value = get('acctName'); nm.readOnly = true; lbl.textContent = '닉네임 (내 계정)';
    box.append(el('p', {}, el('b', { textContent: get('acctName') }), ' 님으로 로그인했어요.'),
      el('div', { className: 'row' }, el('button', { type: 'button', className: 'btn sm', textContent: '로그아웃', onclick: () => logout(false) })));
  } else {
    if (nm.readOnly) nm.value = get('name') || ''; // 로그아웃하면 게스트로 쓰던 닉네임으로 돌아간다
    nm.readOnly = false; lbl.textContent = '닉네임';
    if (authInfo.allowed) {
      box.append(el('p', { textContent: '로그인하면 쪽지를 주고받고, 내 닉네임을 지킬 수 있어요.' }),
        el('div', { className: 'row' },
          el('button', { type: 'button', className: 'btn sm', textContent: '로그인', onclick: () => openAuth('login') }),
          el('button', { type: 'button', className: 'btn sm', textContent: '가입하기', onclick: () => openAuth('signup') })));
    } else if (authInfo.host) {
      box.append(el('p', { textContent: '로그인과 가입은 아래 주소에서 할 수 있어요. 지금 주소에서는 게스트로 방에 들어올 수 있어요.' }), el('a', { className: 'btn sm', href: 'https://' + authInfo.host, textContent: authInfo.host + ' 로 가기' }));
    }
  }
  refresh();
}

/* ---------- 로그인·가입·새 비밀번호 창 ---------- */
let authMode = 'login';
function setAuthMode(mode, note = '') {
  authMode = mode;
  const login = mode === 'login', signup = mode === 'signup', change = mode === 'change';
  $('#authTitle').textContent = login ? '로그인' : signup ? '가입하기' : '새 비밀번호 정하기';
  $('#authTabs').hidden = change;
  $('#authTabLogin').setAttribute('aria-selected', login); $('#authTabSignup').setAttribute('aria-selected', signup);
  $('#authNameRow').hidden = change; $('#authOldRow').hidden = !change; $('#authPw2Row').hidden = login; $('#authCodeRow').hidden = !signup;
  $('#authPwLbl').textContent = change ? '새 비밀번호' : '비밀번호';
  $('#authPw').autocomplete = login ? 'current-password' : 'new-password';
  $('#authGo').textContent = login ? '로그인' : signup ? '가입하기' : '비밀번호 바꾸기';
  let n = note;
  if (!n) n = signup ? (authInfo.signupOpen ? '호스트에게 받은 가입 코드가 필요해요. 비밀번호는 8자 이상이에요. 닉네임은 나중에 7일에 한 번 바꿀 수 있어요.' : '지금은 가입이 닫혀 있어요. 호스트가 가입 코드를 정해야 가입할 수 있어요.')
    : change ? '임시 비밀번호로 들어왔어요. 새 비밀번호를 정해 주세요.' : '';
  if (!authInfo.allowed && authInfo.host) n = `로그인과 가입은 https://${authInfo.host} 에서만 할 수 있어요. ${n}`;
  $('#authNote').textContent = n; $('#authNote').hidden = !n;
  $('#authOld').value = change ? pendingTemp : '';
}
function openAuth(mode = 'login', note = '') {
  setAuthMode(mode, note);
  $('#authMsg').textContent = '';
  if (typeof authDlg.showModal === 'function') { if (!authDlg.open) authDlg.showModal(); } else { authDlg.setAttribute('open', ''); authDlg.classList.add('fallback'); }
  (mode === 'change' ? $('#authPw') : $('#authName')).focus();
}
function closeAuth() { if (typeof authDlg.close === 'function') authDlg.close(); else authDlg.removeAttribute('open'); }
$('#authClose').onclick = (e) => { e.preventDefault(); closeAuth(); };
authDlg.addEventListener('click', (e) => { if (e.target === authDlg) closeAuth(); });
$('#authTabLogin').onclick = () => setAuthMode('login');
$('#authTabSignup').onclick = () => setAuthMode('signup');
$('#acctLogin').onclick = () => { closeSettings(); openAuth('login'); };
$('#dmLogin').onclick = () => openAuth('login', '쪽지는 로그인한 사람끼리만 주고받을 수 있어요.');

// 로그인한 뒤: 방 안에서 했다면 새로 열어 그 계정으로 입장한다
function afterLogin() {
  acctUi();
  if (joined) { try { sessionStorage.setItem('autoJoin', '1'); } catch {} location.reload(); } else authUi();
}
$('#authForm').onsubmit = async (e) => {
  e.preventDefault();
  const msg = $('#authMsg'), name = $('#authName').value.trim(), pw = $('#authPw').value;
  msg.textContent = '';
  if (!authInfo.allowed) return void (msg.textContent = `로그인과 가입은 https://${authInfo.host} 에서만 할 수 있어요.`);
  if (authMode === 'change') {
    if (pw !== $('#authPw2').value) return void (msg.textContent = '새 비밀번호가 서로 달라요.');
    $('#authGo').disabled = true;
    const r = await e2eePasswordChange($('#authOld').value, pw);
    $('#authGo').disabled = false;
    if (!r.ok) return void (msg.textContent = r.msg || '바꾸지 못했어요.');
    pendingTemp = ''; $('#authPw').value = $('#authPw2').value = ''; closeAuth(); return afterLogin();
  }
  if (!name) return void (msg.textContent = '닉네임을 입력해 주세요.');
  if (!pw) return void (msg.textContent = '비밀번호를 입력해 주세요.');
  if (authMode === 'signup' && pw !== $('#authPw2').value) return void (msg.textContent = '비밀번호가 서로 달라요.');
  $('#authGo').disabled = true;
  const r = authMode === 'login' ? await authPost('/auth/login', { name, password: pw })
    : await authPost('/auth/signup', { name, password: pw, code: $('#authCode').value.trim() });
  $('#authGo').disabled = false;
  if (!r.ok) return void (msg.textContent = r.msg || '처리하지 못했어요.');
  set('acctName', r.name);
  if (!r.mustChange) await e2eeAfterAuth(pw, authMode === 'login' ? r.keys : null); // 쪽지 보안 키: 로그인이면 맡겨 둔 키를 풀고, 가입이면 새로 만든다
  if (r.mustChange) { pendingTemp = pw; $('#authPw').value = $('#authPw2').value = ''; return setAuthMode('change'); } // 임시 비밀번호: 새로 정해야 입장할 수 있다
  $('#authPw').value = $('#authPw2').value = ''; closeAuth(); afterLogin();
};

async function logout(all) {
  if (get('pushOn') && joined) { try { await disablePush(); } catch {} } // 이 브라우저의 알림 구독을 풀어서, 다음에 로그인하는 사람에게 이 사람의 알림이 가지 않게
  await authPost(all ? '/auth/logout-all' : '/auth/logout');
  clearLogin(); await e2eeClear(); location.reload();
}

/* ---------- 설정 창의 "계정" ---------- */
function acctUi() {
  $('#acctGuest').hidden = loggedIn(); $('#acctIn').hidden = !loggedIn();
  $('#acctLogin').hidden = !authInfo.allowed;
  $('#acctGuestNote').textContent = authInfo.allowed ? '로그인하면 쪽지를 주고받고, 닉네임을 내 것으로 지킬 수 있어요. 지금은 게스트예요.' : (authInfo.host ? `로그인과 가입은 https://${authInfo.host} 에서만 할 수 있어요. 지금 주소에서는 게스트로만 쓸 수 있어요.` : '');
  if (loggedIn()) $('#acctInfo').textContent = `${get('acctName')} 님으로 로그인했어요.` + (myPrev ? ` (이전 닉네임: ${myPrev})` : '');
}
let myPrev = ''; // 내 이전 닉네임 (입장하면 서버가 알려 준다)
const setMsg = (id, t, ok) => { const n = $('#' + id); n.textContent = t; n.classList.toggle('ok', !!ok); };
$('#renGo').onclick = async () => {
  const r = await authPost('/auth/rename', { name: $('#renIn').value });
  if (!r.ok) return setMsg('renMsg', r.msg || '바꾸지 못했어요.');
  set('acctName', r.name); myPrev = r.prev || myPrev; $('#renIn').value = '';
  setMsg('renMsg', `닉네임을 "${r.name}"으로 바꿨어요.`, true); acctUi(); if (!joined) authUi();
};
$('#pwGo').onclick = async () => {
  if ($('#pwNew').value !== $('#pwNew2').value) return setMsg('pwMsg', '새 비밀번호가 서로 달라요.');
  const r = await e2eePasswordChange($('#pwOld').value, $('#pwNew').value);
  if (!r.ok) return setMsg('pwMsg', r.msg || '바꾸지 못했어요.');
  $('#pwOld').value = $('#pwNew').value = $('#pwNew2').value = '';
  setMsg('pwMsg', '비밀번호를 바꿨어요. 다른 기기에서는 로그아웃돼요.', true);
};
$('#logoutBtn').onclick = () => logout(false);
$('#logoutAllBtn').onclick = () => confirm('모든 기기에서 로그아웃할까요?') && logout(true);
$('#delGo').onclick = async () => {
  if (!confirm('정말 계정을 삭제할까요? 닉네임은 다른 사람이 쓸 수 있게 되고, 되돌릴 수 없어요. 내가 보낸 쪽지는 상대 화면에 "탈퇴한 사용자"로 남아요.')) return;
  if (get('pushOn') && joined) { try { await disablePush(); } catch {} }
  const r = await authPost('/auth/delete', { password: $('#delPw').value });
  if (!r.ok) return setMsg('delMsg', r.msg || '삭제하지 못했어요.');
  clearLogin(); await e2eeClear(); location.reload();
};

/* ---------- 설정 창의 "계정 관리" (호스트·관리자) ---------- */
function refreshAdmin() {
  $('#adminSec').hidden = !(joined && isAdmin); // 계정 관리는 관리자만 (호스트는 게스트일 수도 있어서)
  if (joined && isAdmin) send({ t: 'acct-list' });
}
$('#settingsBtn').addEventListener('click', () => { acctUi(); refreshAdmin(); });
$('#joinSettings').addEventListener('click', () => { acctUi(); });
$('#acctRefresh').onclick = refreshAdmin;
function renderAccts(list) {
  const ul = $('#acctList'); ul.replaceChildren();
  for (const a of list) {
    const admin = a.role === 'admin';
    const btns = el('div', { className: 'btns' });
    if (!admin) btns.append(
      el('button', { type: 'button', className: 'btn sm', textContent: '임시 비밀번호', onclick: () => confirm(`${a.name} 님의 비밀번호를 초기화할까요? 모든 기기에서 로그아웃되고, 임시 비밀번호가 만들어져요.`) && send({ t: 'acct-reset', uid: a.uid }) }),
      el('button', { type: 'button', className: 'btn sm', textContent: '밴', onclick: () => confirm(`${a.name} 님의 계정을 밴할까요? (풀려면 참가자 탭의 차단 목록에서 해제해요)`) && send({ t: 'acct-ban', uid: a.uid, on: true }) }),
      el('button', { type: 'button', className: 'btn sm danger', textContent: '삭제', onclick: () => confirm(`${a.name} 님의 계정을 삭제할까요? 되돌릴 수 없어요.`) && send({ t: 'acct-delete', uid: a.uid }) }));
    const nm = el('span', { className: 'nm', textContent: a.name });
    ul.append(el('li', {}, el('div', {}, nm, a.prev ? el('small', { className: 'prev', textContent: ' 이전: ' + a.prev }) : '', admin ? tag('관리자') : '', a.online ? tag('접속 중', true) : ''), btns));
  }
}

/* ---------- 서버가 보내는 로그인 관련 소식 ---------- */
const LOGOUT_WHY = {
  deleted: '계정이 삭제됐어요.', password: '비밀번호가 바뀌어서 로그아웃됐어요. 다시 로그인해 주세요.', 'logout-all': '모든 기기에서 로그아웃했어요.',
  reset: '관리자가 비밀번호를 초기화했어요. 받은 임시 비밀번호로 다시 로그인해 주세요.',
};
Object.assign(handlers, {
  'auth-expired'(m) { // 토큰이 만료됐거나 폐기됐다: 게스트로 계속하고 알린다
    clearLogin(); myPrev = '';
    joinNote = m.reuse ? '이 로그인이 다른 곳에서 쓰인 흔적이 있어서 로그아웃했어요. 다시 로그인해 주세요.' : '로그인이 풀렸어요. 다시 로그인해 주세요.';
    authUi(); acctUi();
  },
  'must-change'() { joinNote = '임시 비밀번호로 들어왔어요. 새 비밀번호를 정한 뒤에 입장할 수 있어요.'; openAuth('change'); },
  'login-required'() { joinNote = '쪽지함은 로그인한 사람만 쓸 수 있어요.'; authUi(); openAuth('login', joinNote); },
  async 'logged-out'(m) { // 서버가 이 로그인을 끊었다 (계정 삭제, 비밀번호 변경, 초기화 …)
    ended = true; clearLogin(); await e2eeClear();
    try { sessionStorage.setItem('loginNote', LOGOUT_WHY[m.reason] || '로그아웃됐어요.'); } catch {}
    location.reload();
  },
  renamed(m) { // 누군가 닉네임을 바꿨거나 계정을 지웠다: 목록·말풍선·쪽지 이름을 새 이름으로 맞춘다
    const ids = new Set();
    for (const u of users) if (u.uid && u.uid === m.uid) { u.name = m.name; u.prev = m.prev || ''; ids.add(u.id); }
    document.querySelectorAll('#chat .m[data-sid]').forEach((row) => { if (ids.has(row.dataset.sid)) row.querySelector('.bubble header b').textContent = m.name; });
    if (m.uid && m.uid === meUid) { set('acctName', m.name); myPrev = m.prev || ''; acctUi(); }
    const p = dmPeers.get(m.uid);
    if (p) {
      Object.assign(p, { name: m.name, prev: m.prev || '' });
      if (m.deleted) { p.deleted = true; p.color = null; }
      dmRender();
      if (dmOpenUid === m.uid) { renderThreadHeader(); dmDrawThread(dmThreads.get(m.uid) || []); }
    }
    renderUsers();
    if (!$('#adminSec').hidden) refreshAdmin();
  },
  accts(m) { renderAccts(m.list); },
  'acct-reset'(m) { setMsg('acctMsg', `${m.name} 님의 임시 비밀번호: ${m.temp}  (이 화면에서만 보여요. 직접 알려 주세요. 로그인하면 바로 새 비밀번호를 정하게 돼요.)`, true); refreshAdmin(); },
  'acct-deleted'() { setMsg('acctMsg', '계정을 삭제했어요.', true); refreshAdmin(); },
});

// 로그아웃·삭제로 입장 화면이 새로 열렸을 때 이유를 보여 준다
try { const n = sessionStorage.getItem('loginNote'); if (n) { sessionStorage.removeItem('loginNote'); $('#joinMsg').textContent = n; } } catch {}
authUi(); acctUi();
