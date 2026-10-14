// 요청 묶음 B(편의 기능)를 실제 브라우저로 확인한다:
//  링크·마크다운, 유튜브 링크 카드와 "대기열에 추가"(호스트에게만), 영상 소리 슬라이더, 사람별 소리 크기 창,
//  설정의 프로필·닉네임 바꾸기, 개인정보·약관 읽기, 같은 계정 기기 합치기.
// 실행: node tools/round3b-ui-check.js
const { launch, wait, reporter } = require('./_cdp');
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

(async () => {
  const h = await launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const { check, done } = reporter();
  try {
    const A = await h.page(1100, 800); await A.type('#nameIn', '호스트'); await A.tap('#enter'); await A.until('joined');
    const B = await h.page(1100, 800); await B.type('#nameIn', '손님'); await B.tap('#enter'); await B.until('joined');
    const say = async (p, text) => { await p.type('#chatIn', text); await p.js(`document.querySelector('#chatForm').requestSubmit()`); await wait(450); };

    console.log('링크와 마크다운');
    { // 정규식의 '뒤돌아보기'는 iOS Safari 16.4 부터라서, 쓰면 오래된 아이폰에서 그 파일이 통째로 안 읽혀 채팅이 안 뜬다
      const fs = require('fs'), path = require('path'), dir = path.join(__dirname, '..', 'public');
      const bad = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).filter((f) => /\(\?<[=!]/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
      check(bad.length === 0, '화면 파일에 정규식 뒤돌아보기가 없음 (오래된 아이폰에서 파일이 안 읽히는 것을 막음)' + (bad.length ? ': ' + bad.join() : ''));
    }
    await say(A, '**굵게** *기울임* ~~취소~~ `코드` ||비밀|| 링크 https://example.com/a_b_c?x=1, 끝');
    check(await B.until(`document.querySelector('#chat .bubble strong')?.textContent === '굵게' && document.querySelector('#chat .bubble em')?.textContent === '기울임' && document.querySelector('#chat .bubble s')?.textContent === '취소' && document.querySelector('#chat .bubble code.ic')?.textContent === '코드'`), '굵게·기울임·취소선·코드가 꾸며짐');
    check(await B.js(`(() => { const a = document.querySelector('#chat .bubble a.lnk'); return a && a.href === 'https://example.com/a_b_c?x=1' && a.target === '_blank' && a.rel.includes('noopener') && a.textContent === 'https://example.com/a_b_c?x=1'; })()`), '링크가 눌러 열리고(새 창, noopener), 끝의 쉼표는 링크에서 빠지고, 주소 속 밑줄은 기울임으로 읽히지 않음');
    check(await B.js(`(() => { const s = document.querySelector('#chat .bubble .spoiler'); return s && !s.classList.contains('shown') && getComputedStyle(s).color !== getComputedStyle(document.body).color; })()`), '스포일러는 가려져 있음');
    await B.tap('#chat .bubble .spoiler');
    check(await B.js(`document.querySelector('#chat .bubble .spoiler').classList.contains('shown')`), '스포일러를 누르면 보임');
    await say(A, '```x = 1; y = **2**``` 그리고 \\*별\\*');
    check(await B.until(`document.querySelector('#chat .bubble pre.cb code')?.textContent === 'x = 1; y = **2**'`), '코드 블록 안은 마크다운으로 풀지 않음');
    check(await B.js(`[...document.querySelectorAll('#chat .bubble p')].at(-1).textContent.includes('*별*') && ![...document.querySelectorAll('#chat .bubble em')].some((e) => e.textContent === '별')`), '앞에 \\ 를 붙이면 그대로 보임');
    await say(A, 'snake_case_name 그리고 _진짜 기울임_ 과 ** 별 두 개** 와 *앞뒤공백 * 그리고 ~~~삼중~~~');
    const lastB = `[...document.querySelectorAll('#chat .bubble')].at(-1)`;
    check(await B.until(`[...${lastB}.querySelectorAll('em')].map((e) => e.textContent).join('|') === '진짜 기울임'`) && await B.js(`${lastB}.textContent.includes('snake_case_name') && !${lastB}.querySelector('strong')`), '낱말 가운데의 _ (snake_case)와 공백으로 시작·끝나는 별표는 꾸밈이 아니고, 앞뒤가 붙은 _진짜 기울임_ 만 기울임');
    await say(A, '> 인용문입니다');
    check(await B.until(`document.querySelector('#chat .bubble blockquote')?.textContent === '인용문입니다'`), '> 로 시작하면 인용');
    await say(A, '<img src=x onerror=alert(1)> javascript:alert(1) [x](javascript:alert(2))');
    check(await B.js(`!document.querySelector('#chat img[src="x"]') && ![...document.querySelectorAll('#chat a')].some((a) => /^javascript:/i.test(a.href))`), '태그나 javascript: 주소는 그림·링크가 되지 않고 글자로만 보임');
    check(await B.js(`[...document.querySelectorAll('#chat .bubble p')].at(-1).textContent.includes('<img src=x onerror=alert(1)>')`), '그 글자 그대로 보임');

    console.log('유튜브 링크 카드와 대기열 버튼 (호스트에게만)');
    await say(A, '이 영상 보자 https://youtu.be/dQw4w9WgXcQ 어때');
    check(await B.until(`!!document.querySelector('#chat .embed.yt')`), '유튜브 링크 밑에 카드가 붙음');
    check(await B.js(`getComputedStyle(document.querySelector('#chat .embed.yt .ytadd')).display === 'none'`), '일반 참가자 화면에는 "대기열에 추가" 버튼이 안 보임');
    check(await A.js(`getComputedStyle(document.querySelector('#chat .embed.yt .ytadd')).display !== 'none'`), '호스트 화면에는 보임');
    await A.tap('#chat .embed.yt .ytadd');
    check(await B.until(`ytWant && ytWant.videoId === 'dQw4w9WgXcQ'`), '버튼을 누르면 영상이 바로 재생 대기열로 들어감(첫 영상이라 바로 재생)');
    check(await A.js(`document.querySelector('#chat .embed.yt .ytadd').disabled && document.querySelector('#chat .embed.yt .ytadd').textContent === '추가했어요'`), '누른 뒤 "추가했어요"로 바뀜');
    await A.js(`send({ t: 'host-give', id: users.find((u) => u.name === '손님').id })`);
    check(await B.until(`isHost && getComputedStyle(document.querySelector('#chat .embed.yt .ytadd')).display !== 'none'`) && await A.js(`getComputedStyle(document.querySelector('#chat .embed.yt .ytadd')).display === 'none'`), '호스트가 바뀌면 버튼도 새 호스트에게만 보임');
    await B.js(`send({ t: 'host-give', id: users.find((u) => u.name === '호스트').id })`); await wait(500);

    console.log('영상 소리 슬라이더');
    check(await A.until(`!document.querySelector('#ytVol').hidden && !document.querySelector('#ytVolIn').hidden`), '영상이 있으면 영상 밑에 소리 슬라이더가 보임');
    await A.js(`(() => { const i = document.querySelector('#ytVolIn'); i.value = 35; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    check(await A.js(`ytVol === 35 && localStorage.getItem('ytVol') === '35' && document.querySelector('#ytVolOut').textContent === '35%'`), '크기를 바꾸면 기억됨');
    await A.tap('#ytMute');
    check(await A.js(`ytMuted && document.querySelector('#ytMute').getAttribute('aria-pressed') === 'true' && localStorage.getItem('ytMuted') === '1'`), '음소거 버튼이 켜지고 기억됨');
    await A.js(`(() => { const i = document.querySelector('#ytVolIn'); i.value = 60; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    check(await A.js(`!ytMuted`), '슬라이더를 올리면 음소거가 풀림');
    const P = await h.page(390, 844, { mobile: true, ua: IPHONE }); await P.type('#nameIn', '아이폰'); await P.tap('#enter'); await P.until('joined');
    check(await P.until(`ytWant && !document.querySelector('#ytVol').hidden`) && await P.js(`document.querySelector('#ytVolIn').closest('label').hidden && !document.querySelector('#ytVolNote').hidden`), 'iPhone 에서는 슬라이더 대신 "기기의 음량 버튼으로 조절해요" 안내가 보임');
    check(await P.js(`document.documentElement.scrollWidth <= innerWidth`), '폰 화면 가로로 넘치지 않음');

    console.log('음성 바: 이름을 누르면 소리 크기 조절');
    await A.js(`(voicePrefs.ns = false, document.querySelector('#voiceBtn').click())`); await wait(600);
    await B.js(`(voicePrefs.ns = false, document.querySelector('#voiceBtn').click())`);
    check(await A.until(`document.querySelectorAll('#voiceBar .vp').length === 2`), '두 사람이 음성에 있음');
    const vpOf = (name) => `[...document.querySelectorAll('#voiceBar .vp')].find((c) => c.querySelector('.nm').textContent === '${name}')`;
    await A.tap('#voiceBar .vp:not(:first-child)'); await wait(200);
    check(await A.js(`!!document.querySelector('#vpop input[type=range]') && document.querySelector('#vpop').getAttribute('aria-label').includes('목소리 크기')`), '상대 칩을 누르면 목소리 크기 창이 뜸');
    await A.js(`(() => { const i = document.querySelector('#vpop input'); i.value = 150; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    check(await A.js(`voiceVol['g:손님'] === 1.5 && document.querySelector('#vpop output').textContent === '150%'`), '크기를 바꾸면 그 사람(게스트는 닉네임)에게만 기억됨');
    check(await A.js(`(() => { const r = document.querySelector('#vpop').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()`), '창이 화면 안에 들어옴');
    await A.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    check(await A.js(`!document.querySelector('#vpop')`), 'Esc 로 닫힘');
    await A.js(`voiceVol = {}; set('voiceVol', '{}')`);
    check(await A.until(`document.querySelector('#voiceBar .vp .av.speaking') !== null`, 8000), '작은 소리에도 말하는 표시가 켜짐');
    check(await A.js(`document.querySelector('#voiceBar .vp').getAttribute('tabindex') === '0' && document.querySelector('#voiceBar .vp').classList.contains('clk')`), '칩이 키보드로도 열림(Tab·Enter)');
    await A.js(`document.querySelector('#voiceBtn').click()`); await B.js(`document.querySelector('#voiceBtn').click()`);

    console.log('같은 계정의 여러 기기는 한 줄로');
    await A.js(`(() => { users = users.concat([{ id: 'dev1', uid: 'abcabcabcabc', name: '두기기', acct: true, device: 'pc' }, { id: 'dev2', uid: 'abcabcabcabc', name: '두기기', acct: true, device: 'mobile' }]); renderUsers(); })()`);
    check(await A.js(`[...document.querySelectorAll('#users .nm > span')].filter((s) => s.textContent === '두기기').length === 1 && document.querySelector('#dot-users').textContent === '4'`), '같은 계정 기기 2대가 한 줄이고 인원은 4명(호스트·손님·아이폰·두기기)으로 셈');
    check(await A.js(`[...document.querySelectorAll('#users li')].find((l) => l.textContent.includes('두기기')).textContent.includes('기기 2대')`), '"기기 2대"가 표시됨');
    await A.js(`users = users.filter((u) => !u.id.startsWith('dev')); renderUsers()`);

    console.log('설정: 프로필');
    await A.tap('#settingsBtn');
    check(await A.js(`[...document.querySelectorAll('#setNav .set-tab')].some((b) => b.textContent.startsWith('프로필'))`), '설정 목록에 "프로필"이 있음');
    await A.js(`setPage('profile')`); await wait(300);
    check(await A.js(`(() => { const d = document.querySelector('#settings'); return d.scrollHeight <= d.clientHeight + 1; })()`), '프로필 페이지에서 설정 창 자체가 스크롤되지 않음 (스크롤은 안쪽 한 곳만)');
    check(await A.js(`getComputedStyle(document.querySelector('#emojis')).overflowY === 'visible'`), '이모티콘 목록에 안쪽 스크롤 칸이 따로 없음');
    check(await A.js(`[...document.querySelectorAll('#emojis button')].every((b) => { const i = b.querySelector('img'), br = b.getBoundingClientRect(), ir = i.getBoundingClientRect(); return Math.abs((ir.left + ir.width / 2) - (br.left + br.width / 2)) <= 1.5 && Math.abs((ir.top + ir.height / 2) - (br.top + br.height / 2)) <= 1.5 && ir.width < br.width; })`), '이모티콘 그림이 버튼 한가운데에 있음 (어긋남 1.5px 이내)');
    check(await A.js(`(() => { const d = document.querySelector('#settings'); return ['look', 'profile', 'voice', 'hide', 'acct', 'app'].every((c) => { setPage(c); return d.scrollHeight <= d.clientHeight + 1; }); })()`), '다른 설정 페이지에서도 창 자체가 스크롤되지 않음');
    await A.js(`setPage('profile')`); await wait(200);
    check(await A.js(`!!document.querySelector('#pgProfile .make #emojis') && document.querySelectorAll('#pgProfile #emojis button').length > 20 && !document.querySelector('#profGuestName').hidden`), '설정 안에서 이모티콘·사진·색을 고를 수 있음 (게스트는 닉네임 바꾸기 칸이 있음)');
    await A.tap('#emojis button[data-e="🦊"]'); await A.until(`avatarCache.key.startsWith('🦊')`);
    const before = await B.js(`users.find((u) => u.name === '호스트').avatar`);
    await A.tap('#profSave');
    check(await B.until(`users.find((u) => u.name === '호스트').avatar !== ${JSON.stringify(before)}`), '저장하면 다른 사람 화면에도 바로 바뀜');
    check(await A.js(`document.querySelector('#profMsg').textContent.includes('저장했어요')`), '저장 안내가 보임');
    await A.type('#gRenIn', '새이름'); await A.tap('#gRenGo');
    check(await B.until(`users.some((u) => u.name === '새이름') && !users.some((u) => u.name === '호스트')`), '게스트가 닉네임을 바꾸면 다른 사람 목록에 바로 반영됨');
    check(await B.js(`[...document.querySelectorAll('#chat .m[data-sid] .bubble header b')].some((b) => b.textContent === '새이름')`), '이미 올라온 말풍선의 이름도 바뀜');
    await A.type('#gRenIn', '또바꿈'); await A.tap('#gRenGo');
    check(await A.until(`document.querySelector('#gRenMsg').textContent.includes('30초')`), '곧바로 또 바꾸면 도배 방지 안내');

    console.log('설정: 약관·정보');
    await A.js(`setPage('app')`); await wait(300);
    check(await A.js(`document.querySelector('#srcLink').href === 'https://github.com/LaeDev/SiruGC' && document.querySelector('#srcLink').rel.includes('noopener')`), 'GitHub 링크 버튼이 있음');
    await A.tap('#docPrivacy'); await wait(700);
    check(await A.js(`document.querySelector('#docDlg').open && document.querySelector('#docTitle').textContent === '개인정보처리방침' && document.querySelectorAll('#docBody table tr').length > 10 && document.querySelectorAll('#docBody h3').length >= 5`), '개인정보처리방침이 제목·표로 읽힘');
    check(await A.js(`(() => { const b = document.querySelector('#docBody'); return b.scrollWidth <= b.clientWidth + 1 || getComputedStyle(b.querySelector('.md-tw')).overflowX === 'auto'; })()`), '넓은 표는 문서 안에서 옆으로 넘기게 됨');
    await A.tap('#docClose');
    await A.tap('#docTerms'); await wait(700);
    check(await A.js(`document.querySelector('#docDlg').open && document.querySelector('#docTitle').textContent === '이용약관' && document.querySelector('#docBody').textContent.length > 300`), '이용약관이 읽힘');
    await A.shot('E:/tmpchk/r3b-doc.png');
    await A.tap('#docClose');
  } finally { await h.close(); }
  process.exit(done());
})().catch((e) => { console.error(e); process.exit(1); });
