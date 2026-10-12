// public/*.js 는 서로 전역을 공유하는 클래식 스크립트라서, 같은 이름을 두 파일에서 선언하면 뒤에 불러온 파일 전체가 조용히 실행되지 않는다.
// 최상위 선언(const/let/var/function/class) 이름이 파일 사이에 겹치는지 확인한다. (sw.js는 따로 도는 파일이라 뺀다)
// 실행: node tools/globals-check.js
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'public');
const seen = new Map();
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && x !== 'sw.js')) {
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    const m = line.match(/^(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/);
    if (m) seen.set(m[1], [...(seen.get(m[1]) || []), f]);
  }
}
const dup = [...seen].filter(([, files]) => files.length > 1);
for (const [name, files] of dup) console.log(`  실패 "${name}"을(를) ${files.join(', ')} 에서 모두 선언함`);
console.log(dup.length ? `\n실패 ${dup.length}건` : `모두 통과 (전역 이름 ${seen.size}개, 겹침 없음)`);
process.exit(dup.length ? 1 : 0);
