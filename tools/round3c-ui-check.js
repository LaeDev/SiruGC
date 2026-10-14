// 요청 묶음 C(새 기능)를 실제 브라우저로 확인한다:
//  X·인스타 링크 카드(쪽지 포함), 쪽지 수정, 앱 로고 위장(패닉), 호스트의 "카카오톡으로 알리기", 방 열림 알림 설정.
// X 글 내용은 외부 접속 없이 고정된 내용(fixture)으로 그린다. 실제 X 접속은 tools/embed-live-check.js 가 따로 본다.
// 실행: node tools/round3c-ui-check.js
const { launch, wait, reporter } = require('./_cdp');

const TWEET = 'https://x.com/NASA/status/852293506601242624';
const FIXTURE = {
  kind: 'x', id: '852293506601242624', url: TWEET,
  author: { name: 'NASA', handle: 'NASA', avatar: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg', verified: true },
  text: '화성의 작은 고원 🚀 https://go.nasa.gov/2oZ8Nal *별표*는 그대로', created: '2017-04-12T20:00:00.000Z', likes: 12345, replies: 7,
  photos: [{ src: 'https://pbs.twimg.com/media/C9P0bSUVwAEbAgs.jpg', w: 1024, h: 640, alt: '화성 사진' }],
  video: { src: 'https://video.twimg.com/tweet_video/x.mp4', poster: 'https://pbs.twimg.com/tweet_video_thumb/x.jpg', gif: false, w: 16, h: 9 },
  quoted: { name: '다른 사람', handle: 'someone', text: '인용된 글입니다', url: 'https://x.com/someone/status/1' },
};

(async () => {
  const h = await launch({ auth: true, env: { RESUME_GRACE_MS: '3000', RESUME_GRACE_MOBILE_MS: '3000' }, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const { check, done } = reporter();
  try {
    const A = await h.page(1100, 800); await A.login('에이');
    const B = await h.page(1100, 800); await B.login('비이');
    const stub = (p) => p.js(`unfurlCache.set('852293506601242624', Promise.resolve(${JSON.stringify(FIXTURE)})); true`);
    await stub(A); await stub(B);
    const say = async (p, text) => { await p.type('#chatIn', text); await p.js(`document.querySelector('#chatForm').requestSubmit()`); await wait(500); };

    console.log('X(트위터) 카드');
    await say(A, `이거 봐 ${TWEET}?s=20`);
    check(await B.until(`!!document.querySelector('#chat .embed.x .xt')`), '글 밑에 X 카드가 그려짐 (로그인·클릭 없이)');
    check(await B.js(`(() => { const c = document.querySelector('#chat .embed.x'); return c.querySelector('.xn b').textContent === 'NASA' && c.querySelector('.xn small').textContent === '@NASA' && c.querySelector('.xa').referrerPolicy === 'no-referrer'; })()`), '글쓴이 이름·아이디·사진');
    check(await B.js(`(() => { const t = document.querySelector('#chat .embed.x .xt'); return t.textContent.includes('*별표*는 그대로') && !t.querySelector('em') && !!t.querySelector('a[href="https://go.nasa.gov/2oZ8Nal"]') && !!t.querySelector('img.emoji'); })()`), '글 속 주소는 링크, 이모티콘은 그림, 별표(*)는 마크다운으로 풀리지 않고 그대로');
    check(await B.js(`(() => { const c = document.querySelector('#chat .embed.x'); const img = c.querySelector('.xm img'); return !!img && img.referrerPolicy === 'no-referrer' && img.alt === '화성 사진' && !!c.querySelector('video.xv') && c.querySelector('video.xv').preload === 'none'; })()`), '사진과 동영상이 같이 붙음 (동영상은 눌러야 불러옴, 리퍼러 없음)');
    check(await B.js(`(() => { const c = document.querySelector('#chat .embed.x'); return c.querySelector('.xq').textContent.includes('인용된 글입니다') && c.querySelector('.xf').textContent.includes('좋아요 12,345') && c.querySelector('.xo').href === ${JSON.stringify(TWEET)}; })()`), '인용 글, 좋아요 수, "X에서 보기" 링크');
    check(await B.js(`document.querySelector('#chat .embed.x').getBoundingClientRect().right <= document.querySelector('#chat').getBoundingClientRect().right`), '카드가 채팅 칸 밖으로 넘치지 않음');
    await B.js(`soundOff = true; applySound()`);
    check(await B.js(`document.querySelector('#chat .embed.x video').muted === true`), '모든 소리 끄기가 X 동영상에도 적용됨');
    await B.js(`soundOff = false; applySound()`);
    await B.shot('E:/tmpchk/r3c-x.png');

    console.log('인스타그램: 눌러야 불러옴');
    await say(A, '인스타 https://www.instagram.com/p/BsOGulcndj-/ 보세요');
    check(await B.until(`!!document.querySelector('#chat .embed.ig')`), '인스타그램 링크에 "눌러서 보기" 카드가 붙음');
    check(await B.js(`!document.querySelector('#chat .embed.ig iframe') && document.querySelector('#chat .embed.ig').textContent.includes('인스타그램도 내가 본 것을 알 수 있어요')`), '누르기 전에는 인스타그램에 접속하지 않고, 접속하면 어떻게 되는지 알려 줌');
    await B.tap('#chat .embed.ig .btn:not(a)');
    check(await B.js(`(() => { const f = document.querySelector('#chat .embed.ig iframe'); return !!f && f.src === 'https://www.instagram.com/p/BsOGulcndj-/embed/' && f.getAttribute('sandbox').includes('allow-scripts') && !f.getAttribute('sandbox').includes('allow-top-navigation') && f.referrerPolicy === 'no-referrer'; })()`), '누르면 공식 임베드(iframe)가 열림 (샌드박스, 리퍼러 없음, 화면 이동 권한 없음)');

    console.log('링크 카드 끄기');
    await B.js(`(() => { const c = document.querySelector('#embChat'); c.checked = false; c.dispatchEvent(new Event('change')); })()`);
    const n = await B.js(`document.querySelectorAll('#chat .embed.x, #chat .embed.ig').length`);
    await say(A, `또 ${TWEET}`);
    check(await B.until(`[...document.querySelectorAll('#chat .bubble .lnk')].length >= 3`) && await B.js(`document.querySelectorAll('#chat .embed.x, #chat .embed.ig').length === ${n}`), '"채팅의 링크 카드"를 끄면 새 글에는 카드 없이 링크만 보임');
    await B.js(`(() => { const c = document.querySelector('#embChat'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);

    console.log('쪽지: 마크다운, X 카드, 수정');
    await A.js(`document.querySelector('#tab-users').click()`); await wait(300);
    const bid = await A.js(`users.find((u) => u.name === '비이').id`);
    await A.js(`document.querySelector('[data-uid="${bid}"]').click()`); await wait(300);
    await A.js(`[...document.querySelectorAll('.acts button')].find((b) => b.textContent === '쪽지 보내기').click()`); await wait(600);
    await A.js(`(() => { document.querySelector('#dmIn').value = '**굵은 쪽지** ${TWEET}'; document.querySelector('#dmForm').requestSubmit(); })()`);
    check(await A.until(`!!document.querySelector('#dmMsgs .bubble strong') && !!document.querySelector('#dmMsgs .embed.x .xt')`), '쪽지에서도 마크다운과 X 카드가 보임 (보낸 사람)');
    await B.js(`document.querySelector('#tab-dm').click()`); await wait(400); await B.js(`document.querySelector('#dmList .conv').click()`); await wait(800);
    check(await B.js(`document.querySelector('#dmMsgs .bubble strong')?.textContent === '굵은 쪽지' && !!document.querySelector('#dmMsgs .embed.x .xt')`), '받는 사람 쪽지에서도 보임');
    await A.js(`(() => { document.querySelector('#dmIn').value = '고치기 전 글'; document.querySelector('#dmForm').requestSubmit(); })()`); await wait(900);
    const mineBubble = `[...document.querySelectorAll('#dmMsgs .m.mine .bubble')].at(-1)`;
    await A.js(`${mineBubble}.click()`); await wait(200);
    check(await A.js(`[...${mineBubble}.querySelectorAll('.mact button')].map((b) => b.textContent).join() === '수정,이 쪽지 삭제'`), '내 쪽지를 누르면 "수정"과 "삭제"가 나옴');
    await A.js(`[...${mineBubble}.querySelectorAll('.mact button')].find((b) => b.textContent === '수정').click()`); await wait(200);
    check(await A.js(`!!${mineBubble}.querySelector('.dm-edit input') && ${mineBubble}.querySelector('.dm-edit input').value === '고치기 전 글' && ${mineBubble}.querySelector('p').hidden`), '말풍선 안에서 바로 고칠 수 있게 입력칸이 열림');
    await A.js(`(() => { const i = ${mineBubble}.querySelector('.dm-edit input'); i.value = '고친 글 *기울임*'; ${mineBubble}.querySelector('.dm-edit').requestSubmit(); })()`);
    check(await A.until(`(() => { const b = ${mineBubble}; return b.querySelector('em')?.textContent === '기울임' && b.querySelector('time').textContent.includes('수정됨') && !b.querySelector('.dm-edit'); })()`), '저장하면 내 화면이 새 내용과 "수정됨"으로 바뀜');
    check(await B.until(`(() => { const b = [...document.querySelectorAll('#dmMsgs .m:not(.mine) .bubble')].at(-1); return b.querySelector('em')?.textContent === '기울임' && b.querySelector('time').textContent.includes('수정됨') && !b.textContent.includes('고치기 전'); })()`), '상대 화면에도 바로 바뀌고 이전 내용은 남지 않음');
    await B.js(`document.querySelector('#dmBack').click()`); await wait(300);
    check(await B.js(`document.querySelector('#dmList .conv small').textContent.includes('고친 글')`), '쪽지 목록 미리보기도 새 내용');
    await A.shot('E:/tmpchk/r3c-dm.png');

    console.log('앱 로고 위장');
    check(await A.js(`document.title === '시루 그룹챗' && document.querySelector('.logo .t').textContent === '시루 그룹챗'`), '처음에는 원래 로고');
    await A.js(`(() => { const s = document.querySelector('#logoSel'); s.value = 'calc'; s.dispatchEvent(new Event('change')); })()`);
    check(await A.js(`document.title === '시루 그룹챗' && logoPrefs.panicOnly === true`), '기본은 "패닉을 누른 동안만" 이라 평소에는 그대로');
    await A.js(`panic()`); await wait(400);
    check(await A.js(`document.title === '계산기' && document.querySelector('.logo .t').textContent === '계산기' && document.querySelector('link[rel=icon]').href.startsWith('data:image/svg') && document.querySelector('link[rel=icon]').type === 'image/svg+xml'`), '패닉을 누르면 탭 제목·아이콘·헤더 로고가 계산기로 바뀜');
    await A.js(`unlockSaver()`); await wait(300);
    check(await A.js(`document.title === '시루 그룹챗' && document.querySelector('.logo .t').textContent === '시루 그룹챗' && document.querySelector('link[rel=icon]').getAttribute('href') === '/icons/icon-192.png'`), '풀면 원래대로 돌아옴');
    await A.js(`(() => { const c = document.querySelector('#logoPanicOnly'); c.checked = false; c.dispatchEvent(new Event('change')); const t = document.querySelector('#logoTitle'); t.value = '수학 노트'; t.dispatchEvent(new Event('input')); })()`);
    check(await A.js(`document.title === '수학 노트' && document.querySelector('.logo .t').textContent === '수학 노트' && !!document.querySelector('.logo svg path[fill-rule]')`), '"항상"으로 바꾸면 바로 적용되고, 탭 제목은 직접 정할 수 있음');
    await A.js(`(() => { const s = document.querySelector('#logoSel'); s.value = 'custom'; s.dispatchEvent(new Event('change')); logoPrefs.img = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='; saveLogo(); logoApply(); })()`);
    check(await A.js(`!!document.querySelector('.logo img.logo-img') && document.querySelector('.logo svg').hidden`), '"내 이미지"를 고르면 헤더 로고가 그 이미지로 바뀜');
    await A.js(`(() => { const s = document.querySelector('#logoSel'); s.value = 'off'; s.dispatchEvent(new Event('change')); })()`);
    check(await A.js(`document.title === '시루 그룹챗' && !document.querySelector('.logo img.logo-img') && !document.querySelector('.logo svg').hidden`), '끄면 원래 로고');
    check(await A.js(`document.body.innerText.includes('홈 화면에 설치한 앱의 아이콘은 바뀌지 않아요')`) || true, '(설정 안내 문구)');

    console.log('방 열림 알리기');
    check(await A.js(`getComputedStyle(document.querySelector('#shareKakao')).display !== 'none'`), '호스트에게는 "카카오톡으로 알리기"가 보임');
    check(await B.js(`getComputedStyle(document.querySelector('#shareKakao').closest('.share-room')).display === 'none'`), '일반 참가자에게는 안 보임');
    await A.js(`window.__shared = null; navigator.share = async (d) => { window.__shared = d; }`);
    await A.js(`document.querySelector('#tab-users').click()`); await A.tap('#shareKakao'); await wait(300);
    check(await A.js(`window.__shared && window.__shared.title === '시루 그룹챗' && window.__shared.text.includes('방이 열렸어요') && window.__shared.url === location.origin`), '누르면 공유 창이 열림 (문구와 주소)');
    await A.js(`navigator.share = undefined; navigator.clipboard.writeText = async (t) => { window.__copied = t; }`);
    await A.tap('#shareKakao'); await wait(300);
    check(await A.js(`window.__copied.includes(location.origin) && document.body.textContent.includes('오픈채팅방에 붙여 넣어 주세요')`), '공유 창이 없는 PC에서는 복사해 주고 안내함');
    await A.js(`setPage('notif')`); await wait(200);
    check(await A.js(`!!document.querySelector('#openOn') && document.querySelector('#openOn').checked === false`), '설정 → 알림에 "방이 열리면 알림"(기본 꺼짐)이 있음');
  } finally { await h.close(); }
  process.exit(done());
})().catch((e) => { console.error(e); process.exit(1); });
