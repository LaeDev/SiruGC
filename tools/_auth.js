// 브라우저 점검 도구 공통: 로그인 설정, 계정 만들기, 화면에 로그인 상태 심기.
// 쪽지는 로그인한 계정만 쓰므로, 쪽지를 점검하는 도구는 입장 전에 이 계정으로 로그인한 상태를 만든다.
const AUTH_ENV = { AUTH_HOST: 'localhost,127.0.0.1,[::1]', AUTH_ALLOW_HTTP: '1', SIGNUP_CODE: 'tool-code', SIGNUP_PER_HOUR: '1000', ADMIN_NAME: '관리자', ADMIN_PASSWORD: 'admin-pass-1' };

const made = new Map();
// 이 서버에 그 닉네임으로 가입한다 (같은 닉네임은 한 번만 가입하고 다시 쓴다). 비밀번호는 'pw-닉네임-12345'
async function signup(port, name) {
  const k = port + ':' + name;
  if (made.has(k)) return made.get(k);
  const password = 'pw-' + name + '-12345';
  const r = await fetch(`http://localhost:${port}/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password, code: 'tool-code' }) });
  const j = await r.json();
  if (!j.ok) throw new Error('가입 실패 ' + name + ' ' + JSON.stringify(j));
  made.set(k, { ...j, password });
  return made.get(k);
}
// 화면(페이지)에서 실행할 코드: 이 기기에 로그인 상태를 만들고 입장 화면을 그에 맞춘다
const loginJs = (a) => `(async () => { localStorage.setItem('tok', ${JSON.stringify(a.token)}); localStorage.setItem('acctName', ${JSON.stringify(a.name)}); authUi(); acctUi(); await e2eeReady; return (await e2eeUnlock(${JSON.stringify(a.password)})).ok; })()`; // 쪽지 보안 키도 이 기기에서 만들어 둔다 (이미 있으면 비밀번호로 푼다)

// 관리자 계정(설정 파일의 ADMIN_NAME/ADMIN_PASSWORD)으로 로그인한다
async function adminLogin(port) {
  const r = await fetch(`http://localhost:${port}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: AUTH_ENV.ADMIN_NAME, password: AUTH_ENV.ADMIN_PASSWORD }) });
  const j = await r.json(); if (!j.ok) throw new Error('관리자 로그인 실패 ' + JSON.stringify(j)); return j;
}
module.exports = { AUTH_ENV, signup, loginJs, adminLogin };
