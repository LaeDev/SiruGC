/* 울림 줄이기 (AudioWorklet) — 방에서 울려 늦게 따라오는 소리를 주파수별로 덜어낸다.
   방식: Lebart 스펙트럼 감산. 지금 프레임보다 50ms 앞선 프레임의 세기에서 "방 울림이 이만큼 남아 있을 것"이라고 어림해 그만큼 뺀다.
   라이브러리·모델 없이 이 기기 안에서만 돈다. 지연은 384샘플(48kHz에서 8ms). 'amount'(0이면 그대로, 1이 보통, 최대 3)가 빼는 정도다. */
const N = 512, H = 256, M = N / 2 + 1, FLOOR = 0.03; // 프레임 512, 한 칸 256 (제곱근 한 윈도로 분석·합성하면 합이 1)
const DELAY = Math.max(1, Math.round(0.05 * sampleRate / H)); // 50ms 앞 프레임
const LATE = Math.exp(-2 * (3 * Math.LN10 / 0.5) * (DELAY * H / sampleRate)); // 울림이 0.5초에 -60dB 떨어진다고 보고, 50ms 뒤 남는 세기 비율
const WIN = Float32Array.from({ length: N }, (_, i) => Math.sin(Math.PI * i / N));
const COS = Float32Array.from({ length: N / 2 }, (_, k) => Math.cos(2 * Math.PI * k / N)), SIN = Float32Array.from({ length: N / 2 }, (_, k) => Math.sin(2 * Math.PI * k / N));
const REV = Uint16Array.from({ length: N }, (_, i) => { let r = 0; for (let b = 1; b < N; b <<= 1) r = (r << 1) | ((i & b) ? 1 : 0); return r; });
function fft(re, im) { // 제자리 radix-2. 역변환은 호출하는 쪽에서 re·im 을 맞바꿔 넣는다
  for (let i = 0; i < N; i++) { const j = REV[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1, step = N / len;
    for (let i = 0; i < N; i += len) for (let j = 0; j < half; j++) {
      const wr = COS[j * step], wi = -SIN[j * step], a = i + j, b = a + half;
      const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
      re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
    }
  }
}
class Dereverb extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'amount', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' }]; }
  constructor() {
    super();
    this.ring = new Float32Array(N); this.w = 0; this.cnt = 0; // 최근 N샘플
    this.ola = new Float32Array(N); this.re = new Float32Array(N); this.im = new Float32Array(N);
    this.out = new Float32Array(2048); this.oi = 0; this.on = 128; // 출력 대기열. 128칸을 0으로 채워 두어야 128샘플씩 읽어도 끊기지 않는다
    this.hist = Array.from({ length: DELAY }, () => new Float32Array(M)); this.hp = 0; // 지난 프레임들의 세기
    this.g = new Float32Array(M).fill(1); this.amount = 0;
  }
  frame() {
    const { re, im, ola, g, hist } = this, old = hist[this.hp], a = this.amount;
    for (let i = 0; i < N; i++) { re[i] = this.ring[(this.w + i) % N] * WIN[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < M; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      const gain = Math.sqrt(Math.max(1 - a * LATE * old[k] / (p + 1e-12), FLOOR)); // 남은 울림 몫을 뺀 뒤 남는 크기 (너무 깎이지 않게 바닥을 둔다)
      g[k] = g[k] * 0.5 + gain * 0.5; old[k] = p; // 프레임마다 확 변하면 찌그러지는 소리가 나서 반씩 섞어 부드럽게
      re[k] *= g[k]; im[k] *= g[k]; if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    }
    this.hp = (this.hp + 1) % DELAY;
    fft(im, re); // 역변환 (re·im 맞바꿈). 결과의 실수부는 re 에 N 배로 남는다
    for (let i = 0; i < N; i++) ola[i] += re[i] / N * WIN[i];
    for (let i = 0; i < H; i++) this.out[(this.oi + this.on++) % this.out.length] = ola[i];
    ola.copyWithin(0, H); ola.fill(0, H);
  }
  process(inputs, outputs, params) {
    const x = inputs[0][0], y = outputs[0][0];
    this.amount = params.amount[0];
    if (x) for (let i = 0; i < x.length; i++) {
      this.ring[this.w] = x[i]; this.w = (this.w + 1) % N;
      if (++this.cnt === H) { this.cnt = 0; this.frame(); }
    }
    for (let i = 0; i < y.length; i++) if (this.on > 0) { y[i] = this.out[this.oi]; this.oi = (this.oi + 1) % this.out.length; this.on--; }
    return true;
  }
}
registerProcessor('dereverb', Dereverb);
