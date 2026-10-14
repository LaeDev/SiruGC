// X(트위터) 링크 카드를 서버에서 확인한다.
//  1) 카드로 바꾸는 규칙(글 범위 자르기, 줄임 주소 펼치기, 허용한 그림 주소만): 실제 X 응답과 같은 모양의 고정 내용으로 → 외부 접속 없이 항상
//  2) 서버의 /unfurl 주소: 주소 검사, 요청 횟수 제한, X 에서 실제로 가져오기 → 인터넷이 안 되면 3)만 건너뛴다
// 실행: node tools/embed-live-check.js
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createUnfurl = require('../unfurl');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 6500 + Math.floor(Math.random() * 300);
let failed = 0;
const check = (ok, msg) => { console.log((ok ? '  통과 ' : '  실패 ') + msg); if (!ok) failed++; };

// 실제 X 응답에서 가져온 모양 (2017년 NASA 사진 글, 움직이는 그림 글)
const PHOTO = { __typename: 'Tweet', favorite_count: 3, created_at: '2017-04-12T20:00:00.000Z', display_text_range: [0, 132], id_str: '852293506601242624',
  text: 'Our Mars Reconnaissance Orbiter saw a small mesa: https://t.co/gpwEJLuL1B https://t.co/gI1ikUSM9g', entities: { urls: [{ url: 'https://t.co/gpwEJLuL1B', expanded_url: 'http://go.nasa.gov/2oZ8Nal' }] },
  user: { name: 'NASA', screen_name: 'NASA', is_blue_verified: true, profile_image_url_https: 'https://pbs.twimg.com/profile_images/1/x_normal.jpg' },
  mediaDetails: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/C9P0bSUVwAEbAgs.jpg', original_info: { width: 1024, height: 640 }, ext_alt_text: '화성' },
    { type: 'photo', media_url_https: 'https://evil.example/x.jpg', original_info: { width: 1, height: 1 } }] };
PHOTO.display_text_range = [0, Array.from('Our Mars Reconnaissance Orbiter saw a small mesa: https://t.co/gpwEJLuL1B').length];
const GIF = { __typename: 'Tweet', id_str: '857039262088388608', text: 'Cassini https://t.co/l58p8NI6fu', display_text_range: [0, 7], user: { name: 'NASA', screen_name: 'NASA' }, mediaDetails: [{ type: 'animated_gif', media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/a.jpg' }],
  video: { aspectRatio: [240, 101], contentType: 'gif', poster: 'https://pbs.twimg.com/tweet_video_thumb/a.jpg', variants: [{ type: 'video/mp4', src: 'https://video.twimg.com/tweet_video/a.mp4' }] } };
const EVIL = { __typename: 'Tweet', id_str: '1', text: 'x', display_text_range: [0, 1], user: { name: 'e', screen_name: 'e', profile_image_url_https: 'javascript:alert(1)' },
  video: { variants: [{ type: 'video/mp4', src: 'https://evil.example/v.mp4' }, { type: 'application/x-mpegURL', src: 'https://video.twimg.com/a.m3u8' }], poster: 'http://pbs.twimg.com/insecure.jpg' } };

(async () => {
  console.log('카드로 바꾸는 규칙');
  const u = createUnfurl();
  const c1 = u.card(PHOTO, '852293506601242624');
  check(c1.text === 'Our Mars Reconnaissance Orbiter saw a small mesa: http://go.nasa.gov/2oZ8Nal', '글 끝의 사진 주소는 빠지고 줄임 주소(t.co)는 원래 주소로 펼쳐짐');
  check(c1.photos.length === 1 && c1.photos[0].src.startsWith('https://pbs.twimg.com/') && c1.photos[0].w === 1024 && c1.photos[0].alt === '화성', '사진은 twimg.com 의 것만 (다른 주소의 그림은 버림)');
  check(c1.author.handle === 'NASA' && c1.author.verified === true && c1.url === 'https://x.com/NASA/status/852293506601242624', '글쓴이와 주소');
  const c2 = u.card(GIF, '857039262088388608');
  check(c2.video && c2.video.gif === true && c2.video.src === 'https://video.twimg.com/tweet_video/a.mp4' && c2.video.w === 240, '움직이는 그림은 영상 주소와 비율을 가짐');
  const c3 = u.card(EVIL, '1');
  check(c3.author.avatar === null && c3.video === null && c3.photos.length === 0, '허용하지 않은 주소(javascript:, 다른 도메인, http)는 모두 버림');
  check(u.xId('https://x.com/NASA/status/852293506601242624?s=20') === '852293506601242624' && u.xId('https://twitter.com/i/web/status/20123') === '20123' && u.xId('https://mobile.twitter.com/NASA/statuses/12345/photo/1') === '12345', '주소에서 글 번호를 뽑음 (x.com, twitter.com, mobile, i/web, statuses)');
  check(!u.xId('https://evil.example/NASA/status/852293506601242624') && !u.xId('https://x.com.evil.example/a/status/123456') && !u.xId('https://x.com/NASA') && !u.xId('javascript:alert(1)') && !u.xId('https://x.com/NASA/status/abc'), 'X 가 아닌 주소, 비슷한 주소, 글이 아닌 주소는 무시');

  console.log('서버의 /unfurl');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unf-'));
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'ignore', env: { ...process.env, PORT, STATE_FILE: path.join(tmp, 's.json'), CONFIG_FILE: path.join(tmp, 'none.env') } });
  try {
    await wait(1500);
    const get = async (url) => { const r = await fetch(`http://127.0.0.1:${PORT}/unfurl?u=${encodeURIComponent(url)}`); return { status: r.status, body: await r.json() }; };
    check((await get('https://evil.example/a')).body.kind === 'none' && (await get('')).body.kind === 'none' && (await get('https://www.instagram.com/p/BsOGulcndj-/')).body.kind === 'none', 'X 가 아닌 주소(인스타그램 포함)는 서버가 접속하지 않고 "없음"으로 답함');
    const live = await get('https://x.com/jack/status/20');
    if (live.body.kind === 'x' && !live.body.unavailable) {
      check(live.body.text === 'just setting up my twttr' && live.body.author.handle === 'jack' && live.body.url === 'https://x.com/jack/status/20', '실제 X 에서 글을 가져옴 (로그인 없이)');
      const t0 = Date.now(); await get('https://x.com/jack/status/20');
      check(Date.now() - t0 < 300, '같은 글은 기억해 두었다가 바로 답함');
    } else console.log('  건너뜀 인터넷이나 X 에 닿지 않아 실제 가져오기는 확인하지 못했어요:', JSON.stringify(live.body).slice(0, 120));
    const gone = await get('https://x.com/nobody/status/1234567890123456789');
    check(gone.body.kind === 'x' && (gone.body.unavailable === true || gone.body.id), '없는 글은 오류 없이 "볼 수 없어요"로 답함');
    let limited = 0; for (let i = 0; i < 45; i++) { const r = await fetch(`http://127.0.0.1:${PORT}/unfurl?u=${encodeURIComponent('https://evil.example/' + i)}`); if (r.status === 429) limited++; }
    check(limited >= 1, `짧은 시간에 너무 많이 물으면 막힘 (${limited}번 거절)`);
    const post = await fetch(`http://127.0.0.1:${PORT}/unfurl?u=x`, { method: 'POST' });
    check(post.status === 405 || post.status === 429, 'GET 이 아닌 요청은 받지 않음');
  } finally { srv.kill(); await wait(300); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
