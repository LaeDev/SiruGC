// 울림 줄이기 워커(public/dereverb.js)를 브라우저·스피커 없이 Node 에서 직접 돌려 숫자로 확인한다.
//  - 줄이기 0 이면 소리가 384샘플 늦게 그대로 나온다 (프레임 이음새가 정확하다는 증거)
//  - 인위적 울림(0.5초에 -60dB 떨어지는 방)이 낀 소리의 꼬리가 크게 줄어든다
//  - 울림이 없는 깨끗한 소리는 거의 그대로 남는다
// 실제 목소리가 자연스러운지는 귀로 들어 봐야 해서 이 도구로는 확인하지 못한다. 소리는 내지 않고 실제 설정도 읽지 않는다.
// 실행: node tools/dereverb-check.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SR = 48000;
let Cls;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'dereverb.js'), 'utf8'), {
  sampleRate: SR, Math, Float32Array, Uint16Array, Array,
  AudioWorkletProcessor: class {}, registerProcessor: (_, c) => (Cls = c),
});

let failed = 0;
const check = (ok, msg) => { console.log((ok ? '  통과 ' : '  실패 ') + msg); if (!ok) failed++; };
let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
const run = (x, amount) => { // 128샘플씩 흘려 보낸다 (브라우저 오디오 처리 단위)
  const p = new Cls(), y = new Float32Array(x.length), prm = { amount: [amount] };
  for (let i = 0; i + 128 <= x.length; i += 128) { const o = [[new Float32Array(128)]]; p.process([[x.subarray(i, i + 128)]], o, prm); y.set(o[0][0], i); }
  return y;
};
const rms = (a, from, to) => { let s = 0; for (let i = from; i < to; i++) s += a[i] * a[i]; return Math.sqrt(s / (to - from)); };
const dB = (a, b) => 20 * Math.log10(a / b);

console.log('줄이기 0: 그대로 지나가는가');
{
  const x = Float32Array.from({ length: SR }, () => rnd() * 0.3), y = run(x, 0);
  let worst = 0; for (let i = 2000; i < x.length - 384; i++) worst = Math.max(worst, Math.abs(y[i + 384] - x[i]));
  console.log(`    384샘플 늦춘 입력과의 최대 차이: ${worst.toExponential(2)}`);
  check(worst < 1e-4, '줄이기 0 이면 384샘플(8ms) 늦게 그대로 나옴');
}

console.log('인위적 울림: 0.2초 소리 + 0.5초에 -60dB 떨어지는 방');
{
  const burst = 0.2 * SR, tailLen = 0.5 * SR, total = 1.5 * SR, rho = 3 * Math.LN10 / 0.5;
  const dry = new Float32Array(total); for (let i = 0; i < burst; i++) dry[i] = rnd() * 0.3;
  const ir = Float32Array.from({ length: tailLen }, (_, t) => (t === 0 ? 1 : rnd() * 0.5) * Math.exp(-rho * t / SR));
  const wet = new Float32Array(total);
  for (let i = 0; i < burst; i++) for (let t = 0; t < tailLen; t++) wet[i + t] += dry[i] * ir[t];
  const from = burst + 0.1 * SR, to = burst + 0.3 * SR; // 소리가 끝나고 0.1~0.3초 뒤의 꼬리
  const base = rms(wet, from, to), head = rms(wet, 0.05 * SR, burst);
  let prev = 0;
  for (const a of [0, 1, 2, 3]) {
    const y = run(wet, a), d = dB(rms(y, from + 384, to + 384), base), dh = dB(rms(y, 0.05 * SR + 384, burst + 384), head);
    console.log(`    줄이기 ${a}: 꼬리 ${d.toFixed(1)} dB / 소리 본체 ${dh.toFixed(1)} dB`);
    if (a === 2) check(d < -6, '줄이기 2: 울림 꼬리가 6 dB 넘게 줄어듦');
    if (a === 2) check(dh > -4, '줄이기 2: 소리 본체는 4 dB 넘게 깎이지 않음');
    if (a > 0) check(d <= prev + 0.5, `줄이기 ${a}: 앞 단계보다 덜 줄어들지 않음`);
    prev = d;
  }
}

console.log('울림 없는 깨끗한 소리 (1초 잡음)');
{
  const x = Float32Array.from({ length: SR }, () => rnd() * 0.3);
  const d = dB(rms(run(x, 1), 12000, 36000), rms(x, 12000 - 384, 36000 - 384));
  console.log(`    줄이기 1: ${d.toFixed(1)} dB`);
  check(d > -3, '줄이기 1: 울림 없는 소리는 3 dB 넘게 깎이지 않음');
}

console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
process.exit(failed ? 1 : 0);
