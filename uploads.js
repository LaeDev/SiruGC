// 채팅·쪽지에 붙이는 사진/동영상 업로드와 제공. server.js에서 한 번 만들어 쓴다.
//
// 보안:
//  - 올리려면 접속 중인 세션마다 따로 발급한 토큰이 있어야 한다 (X-Token).
//  - 형식은 파일 앞부분(매직 바이트)으로 직접 판별한다. 올린 사람이 말하는 확장자/Content-Type은 믿지 않고, HTML/SVG 같은 건 거부한다.
//  - 저장 이름은 무작위 128비트라 주소를 모르면 열 수 없다. 제공할 때 nosniff + CSP sandbox로 브라우저가 스크립트로 해석하지 못하게 한다.
//  - 파일당, 사용자 시간당, 서버 전체 용량에 상한이 있고, 오래된 파일은 자동으로 지운다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MB = 1024 * 1024;
const DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const MAX = { image: (Number(process.env.UPLOAD_MAX_IMAGE_MB) || 12) * MB, video: (Number(process.env.UPLOAD_MAX_VIDEO_MB) || 80) * MB };
const USER_HOURLY = (Number(process.env.UPLOAD_USER_MB_PER_HOUR) || 300) * MB;
const TOTAL = (Number(process.env.UPLOAD_MAX_TOTAL_MB) || 2048) * MB;
const KEEP_MS = Number(process.env.UPLOAD_KEEP_MS) || (Number(process.env.UPLOAD_KEEP_DAYS) || 30) * 86400e3;
const SWEEP_MS = Number(process.env.UPLOAD_SWEEP_MS) || 600e3;
const MAX_CONCURRENT = 4;

const TYPES = { // 확장자 → [Content-Type, 종류]
  jpg: ['image/jpeg', 'image'], png: ['image/png', 'image'], gif: ['image/gif', 'image'], webp: ['image/webp', 'image'],
  mp4: ['video/mp4', 'video'], mov: ['video/quicktime', 'video'], webm: ['video/webm', 'video'],
};
const NAME_RE = /^[0-9a-f]{32}\.(jpg|png|gif|webp|mp4|mov|webm)$/;

// 파일 앞부분으로 형식을 알아낸다. 모르는 형식(HTML, SVG, 실행 파일, HEIC 사진 등)은 null.
function sniff(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  const s = b.subarray(0, 12).toString('latin1');
  if (s.startsWith('GIF87a') || s.startsWith('GIF89a')) return 'gif';
  if (s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP') return 'webp';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (s.slice(4, 8) === 'ftyp') {
    const brand = s.slice(8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis'].includes(brand)) return null; // 사진용 형식: 브라우저가 못 그린다
    return brand === 'qt  ' ? 'mov' : 'mp4';
  }
  return null;
}

module.exports = function createUploads({ findByToken, send }) {
  fs.mkdirSync(DIR, { recursive: true });
  let active = 0;

  const fail = (res, code, msg) => { if (!res.headersSent) res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: msg })); };
  const list = () => fs.readdirSync(DIR).filter((n) => NAME_RE.test(n)).map((n) => { const st = fs.statSync(path.join(DIR, n)); return { n, size: st.size, t: st.mtimeMs }; });

  // 공간이 모자라면 오래된 것부터 지워서 자리를 만든다. 그래도 안 되면 false.
  function makeRoom(need) {
    let files = list().sort((a, b) => a.t - b.t), used = files.reduce((s, f) => s + f.size, 0);
    while (used + need > TOTAL && files.length) { const f = files.shift(); fs.rmSync(path.join(DIR, f.n), { force: true }); used -= f.size; }
    return used + need <= TOTAL;
  }
  function sweep() {
    const cut = Date.now() - KEEP_MS;
    for (const f of fs.readdirSync(DIR)) {
      try {
        const p = path.join(DIR, f), st = fs.statSync(p);
        if (NAME_RE.test(f) ? st.mtimeMs < cut : f.startsWith('.tmp-') && st.mtimeMs < Date.now() - 3600e3) fs.rmSync(p, { force: true });
      } catch {}
    }
  }
  sweep(); setInterval(sweep, SWEEP_MS).unref();

  function upload(req, res) {
    const ws = findByToken(String(req.headers['x-token'] || ''));
    if (!ws || ws.ghost) return fail(res, 401, '로그인한 방에서만 올릴 수 있어요');
    const len = Number(req.headers['content-length']);
    if (!Number.isFinite(len) || len <= 0) return fail(res, 411, '파일 크기를 알 수 없어요');
    if (len > Math.max(MAX.image, MAX.video)) return fail(res, 413, '파일이 너무 커요');
    const now = Date.now();
    ws.uploads = (ws.uploads || []).filter((u) => u.t > now - 3600e3);
    if (ws.uploading || active >= MAX_CONCURRENT) return fail(res, 429, '다른 파일을 올리는 중이에요. 잠시 뒤에 다시 해 주세요');
    if (ws.uploads.reduce((s, u) => s + u.size, 0) + len > USER_HOURLY) return fail(res, 429, '한 시간에 올릴 수 있는 양을 넘었어요');
    if (!makeRoom(len)) return fail(res, 507, '서버 저장 공간이 부족해요');

    ws.uploading = true; active++;
    const tmp = path.join(DIR, '.tmp-' + crypto.randomBytes(8).toString('hex'));
    const out = fs.createWriteStream(tmp);
    let got = 0, head = Buffer.alloc(0), over = false;
    const done = () => { ws.uploading = false; active--; };
    const abort = (code, msg) => { if (over) return; over = true; req.unpipe(out); out.destroy(); fs.rm(tmp, { force: true }, () => {}); done(); fail(res, code, msg); req.resume(); };
    req.on('data', (c) => {
      got += c.length;
      if (head.length < 32) head = Buffer.concat([head, c.subarray(0, 32 - head.length)]);
      if (got > len || got > Math.max(MAX.image, MAX.video)) abort(413, '파일이 너무 커요');
    });
    req.on('aborted', () => abort(400, '업로드가 중간에 끊겼어요'));
    req.pipe(out);
    out.on('error', () => abort(500, '저장하지 못했어요'));
    out.on('finish', () => {
      if (over) return;
      const ext = sniff(head);
      if (!ext) return abort(415, '사진(JPG, PNG, GIF, WebP)이나 동영상(MP4, WebM, MOV)만 올릴 수 있어요');
      const [, kind] = TYPES[ext];
      if (got > MAX[kind]) return abort(413, `${kind === 'image' ? '사진' : '동영상'}은 ${Math.round(MAX[kind] / MB)}MB까지 올릴 수 있어요`);
      const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
      fs.rename(tmp, path.join(DIR, name), (err) => {
        if (err) return abort(500, '저장하지 못했어요');
        ws.uploads.push({ t: Date.now(), size: got });
        done();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ url: '/f/' + name, kind, size: got }));
      });
    });
  }

  // 파일 제공. 동영상 탐색(건너뛰기)을 위해 Range를 지원한다.
  function serve(req, res, name) {
    const file = path.join(DIR, name);
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('파일이 없어요(기간이 지나 지워졌을 수 있어요)');
      const [type] = TYPES[name.split('.')[1]];
      const base = {
        'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Disposition': 'inline',
      };
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (m && (m[1] || m[2])) {
        let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2])), end = m[1] && m[2] ? Number(m[2]) : st.size - 1;
        end = Math.min(end, st.size - 1);
        if (start > end || start >= st.size) return res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
        res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
        return req.method === 'HEAD' ? res.end() : fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { ...base, 'Content-Length': st.size });
      req.method === 'HEAD' ? res.end() : fs.createReadStream(file).pipe(res);
    });
  }

  // server.js의 요청 처리 맨 앞에서 부른다. 처리했으면 true.
  function handle(req, res) {
    if (req.method === 'POST' && req.url === '/upload') { upload(req, res); return true; }
    const m = /^\/f\/([0-9a-f]{32}\.\w+)$/.exec(req.url.split('?')[0]);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) { NAME_RE.test(m[1]) ? serve(req, res, m[1]) : res.writeHead(404).end(); return true; }
    return false;
  }

  // 채팅/쪽지 메시지에 붙은 media 정보를 믿지 않고 다시 확인한다: 우리가 저장한 파일이 실제로 있어야 한다.
  function validMedia(m) {
    const x = m && typeof m.url === 'string' && /^\/f\/([0-9a-f]{32}\.\w+)$/.exec(m.url);
    if (!x || !NAME_RE.test(x[1]) || !fs.existsSync(path.join(DIR, x[1]))) return null;
    const dim = (v) => (Number.isFinite(Number(v)) && Number(v) >= 1 && Number(v) <= 10000 ? Math.round(Number(v)) : undefined);
    return { url: m.url, kind: TYPES[x[1].split('.')[1]][1], w: dim(m.w), h: dim(m.h) };
  }
  return { handle, validMedia, DIR };
};
module.exports.sniff = sniff;
