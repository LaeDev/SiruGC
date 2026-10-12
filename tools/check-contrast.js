// 모든 테마의 글자/배경 대비(WCAG)를 검사한다. 실행: node tools/check-contrast.js
// 글자는 4.5:1, 아이콘·버튼·포커스 링 같은 화면 요소는 3:1 이상이어야 통과.
const fs = require('fs');
const path = require('path');
const pub = path.join(__dirname, '..', 'public');
const base = fs.readFileSync(path.join(pub, 'style.css'), 'utf8').match(/:root\s*\{([^}]*)\}/)[1];
const themesCss = fs.readFileSync(path.join(pub, 'themes.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const parse = (body) => Object.fromEntries([...body.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
const baseTokens = parse(base);
const raw = { 'lamp-dark(기본값)': { ...baseTokens } }; // 테마 규칙이 직접 정한 값(누락 검사용)
const themes = {};
// 규칙 하나가 선택자 여러 개를 가질 수 있다(라이트 테마 공통 의미색): 선택자마다 같은 값을 합친다.
for (const m of themesCss.matchAll(/((?:\[data-theme="[\w-]+"\]\s*,?\s*)+)\{([^}]*)\}/g)) {
  for (const sel of m[1].matchAll(/\[data-theme="([\w-]+)"\]/g)) raw[sel[1]] = { ...(raw[sel[1]] || {}), ...parse(m[2]) };
}
const auto = themesCss.match(/:root:not\(\[data-theme\]\)\s*\{([^}]*)\}/);
if (auto) raw['auto-light(기기가 라이트일 때)'] = parse(auto[1]);
for (const [k, v] of Object.entries(raw)) themes[k] = { ...baseTokens, ...v }; // 정하지 않은 값(의미색 등)은 기본값을 물려받는다

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [전경, 배경, 최소 비율, 설명]
const PAIRS = [
  ['text', 'bg', 4.5, '본문/바탕'], ['text', 'surface', 4.5, '본문/패널'], ['text', 'surface-2', 4.5, '본문/내 말풍선·선택'],
  ['muted', 'bg', 4.5, '보조글자/바탕'], ['muted', 'surface', 4.5, '보조글자/패널'], ['muted', 'surface-2', 4.5, '보조글자/강조면'],
  ['on-accent', 'accent', 4.5, '버튼 글자/버튼'],
  ['accent-text', 'bg', 4.5, '강조글자/바탕'], ['accent-text', 'surface', 4.5, '강조글자/패널'],
  ['danger', 'bg', 4.5, '경고글자/바탕'], ['danger', 'surface', 4.5, '경고글자/패널'],
  ['on-ok', 'ok', 4.5, '초록 버튼 글자/버튼'], ['on-info', 'info', 4.5, '파랑 버튼 글자/버튼'], ['on-danger', 'danger', 4.5, '빨강 버튼 글자/버튼'],
  ['ok', 'bg', 3, '초록 버튼/헤더 바탕'], ['info', 'bg', 3, '파랑 버튼/헤더 바탕'], ['danger', 'bg', 3, '빨강 버튼/헤더 바탕'],
  ['focus', 'bg', 3, '포커스 링/바탕'], ['focus', 'surface', 3, '포커스 링/패널'],
  ['line', 'bg', 1.3, '테두리/바탕(장식)'],
];
const CORE = ['bg', 'surface', 'surface-2', 'line', 'text', 'muted', 'accent', 'on-accent', 'accent-text', 'danger', 'focus'];
let bad = 0;
for (const [name, t] of Object.entries(themes)) {
  const fails = PAIRS.filter(([f, b, min]) => ratio(t[f], t[b]) < min)
    .map(([f, b, min, label]) => `${label} ${ratio(t[f], t[b]).toFixed(2)} (<${min})`);
  const missing = CORE.filter((k) => !raw[name][k]);
  if (missing.length) fails.push('토큰 없음: ' + missing.join(', '));
  console.log((fails.length ? '실패 ' : '통과 ') + name + (fails.length ? '\n     ' + fails.join('\n     ') : ''));
  bad += fails.length;
}
console.log(bad ? `\n문제 ${bad}건` : `\n테마 ${Object.keys(themes).length}개 모두 통과`);
process.exit(bad ? 1 : 0);
