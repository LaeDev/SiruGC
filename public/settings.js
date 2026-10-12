/* ================= 설정 창: 테마 ================= */
const THEME_GROUPS = [
  ['다크', [['lamp-dark', '램프'], ['dracula', 'Dracula'], ['nord', 'Nord'], ['solarized-dark', 'Solarized Dark'], ['gruvbox-dark', 'Gruvbox Dark'],
    ['catppuccin-mocha', 'Catppuccin Mocha'], ['tokyo-night', 'Tokyo Night'], ['rose-pine', 'Rosé Pine']]],
  ['라이트', [['lamp-light', '램프'], ['nord-light', 'Nord Light'], ['solarized-light', 'Solarized Light'], ['gruvbox-light', 'Gruvbox Light'],
    ['catppuccin-latte', 'Catppuccin Latte'], ['rose-pine-dawn', 'Rosé Pine Dawn']]],
];
const settingsDlg = $('#settings');

function syncThemeColor() { // 휴대폰 주소창 색
  $('meta[name=theme-color]').content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
}
function applyTheme(id) {
  if (id === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = id;
  set('theme', id);
  syncThemeColor();
}
function themeCard(id, name, desc) {
  const card = el('label', { className: 'tc' },
    el('input', { type: 'radio', name: 'theme', value: id, checked: (get('theme') || 'auto') === id, onchange: () => applyTheme(id) }),
    el('span', { className: 'tc-p' }, el('i'), el('i'), el('i')),
    el('span', { className: 'tc-n', textContent: name }));
  if (id !== 'auto') card.dataset.theme = id; // 카드 자체를 그 테마의 색으로 그려서 미리보기로 쓴다
  if (desc) card.append(el('span', { className: 'tc-d', textContent: desc }));
  return card;
}
{
  const grid = $('#themeGrid');
  grid.append(el('div', { className: 'tgroup' }, themeCard('auto', '기기 설정 따르기', '기기가 라이트/다크로 바뀌면 같이 바뀌어요')));
  for (const [group, list] of THEME_GROUPS) {
    grid.append(el('h4', { textContent: group }), el('div', { className: 'tgroup' }, ...list.map(([id, name]) => themeCard(id, name))));
  }
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeColor);
syncThemeColor();

// ---- 창 열고 닫기 ----
$('#settingsBtn').onclick = $('#joinSettings').onclick = () => settingsDlg.showModal();
settingsDlg.addEventListener('click', (e) => { if (e.target === settingsDlg) settingsDlg.close(); }); // 바깥을 누르면 닫힘
