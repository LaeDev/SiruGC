// 방 채팅 기록. server.js에서 한 번 만들어 쓴다.
//
// 목적: 폰·태블릿이 다른 앱에 갔다 오는 동안(또는 OS가 탭을 버렸다 다시 열 때) 놓친 채팅을, 돌아온 같은 기기에만 다시 보내 주려고 쓴다.
// 저장: 서버 디스크(별도 파일, 평문)에 최근 MAX개를 두고, 마지막 대화로부터 KEEP_MS(24시간)가 지나면 전부 지운다. 사진·파일은 주소만 남고 파일은 업로드 보관 규칙을 따른다.
// 누구에게: "이 기기(cid)가 방에 있었던 적이 있고, 그 뒤로 못 본 것"만. 처음 들어온 사람에게는 입장 전의 채팅을 주지 않는다.
//           cid 는 해시(앞 10자)로만 저장한다.
const fs = require('fs');
const crypto = require('crypto');

const MAX = 1000, KEEP_MS = 24 * 3600e3;
const tag = (cid) => crypto.createHash('sha1').update(String(cid)).digest('hex').slice(0, 10);

module.exports = function createChatLog(file) {
  let log = [], seq = 0, seen = {}; // seen: 기기 해시 → { t: 마지막으로 방에 있던 시각, f: 처음 들어왔을 때의 seq }
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); log = d.log || []; seq = d.seq || 0; seen = d.seen || {}; } catch {}
  let timer = null;
  const flush = () => { clearTimeout(timer); timer = null; try { fs.writeFileSync(file, JSON.stringify({ seq, log, seen })); } catch (e) { console.warn('채팅 기록을 저장하지 못했어요:', e.message); } };
  const saveSoon = () => { if (!timer) timer = setTimeout(flush, 1000); };
  process.on('exit', () => { if (timer) flush(); });

  function prune() {
    const cut = Date.now() - KEEP_MS;
    if (log.length && log.at(-1).ts <= cut) log = []; // 마지막 대화로부터 24시간이 지나면 전부 지운다 (대화가 이어지는 동안은 최근 1000개까지 남는다)
    log = log.slice(-MAX);
    for (const [k, v] of Object.entries(seen)) if (v.t < cut) delete seen[k];
    saveSoon();
  }
  prune();
  setInterval(prune, 600e3).unref();

  return {
    // 새 채팅을 기록하고 번호(seq)를 붙여 돌려준다
    add(e) {
      log.push({ ...e, seq: ++seq, c: tag(e.cid), cid: undefined });
      if (log.length > MAX) log.shift();
      saveSoon();
      return log[log.length - 1];
    },
    // 이 기기가 방에 들어오거나 나갈 때 알린다 (처음이면 그 시점을 '처음 들어온 때'로 기억)
    touch(cid) {
      const k = tag(cid), v = seen[k];
      seen[k] = { t: Date.now(), f: v ? v.f : seq };
      saveSoon();
    },
    // 이 기기가 아직 못 본 채팅 (lastSeq: 기기가 마지막으로 본 번호). 방에 있던 적이 없는 기기에는 빈 목록
    since(cid, lastSeq) {
      const k = tag(cid), v = seen[k];
      if (!v) return [];
      const from = Math.max(v.f, Number.isInteger(lastSeq) && lastSeq <= seq ? lastSeq : 0);
      return log.filter((e) => e.seq > from).map(({ c, ...e }) => ({ ...e, mine: c === k || undefined }));
    },
    flush, prune,
  };
};
