let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function ensureCtx(): AudioContext | null {
	if (typeof window === 'undefined') return null;
	if (!ctx) {
		const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
		if (!AudioCtx) return null;
		ctx = new AudioCtx();

		// master limiter so a pile-up of simultaneous collisions can't clip/blast
		const compressor = ctx.createDynamicsCompressor();
		compressor.threshold.setValueAtTime(-28, ctx.currentTime);
		compressor.knee.setValueAtTime(24, ctx.currentTime);
		compressor.ratio.setValueAtTime(14, ctx.currentTime);
		compressor.attack.setValueAtTime(0.002, ctx.currentTime);
		compressor.release.setValueAtTime(0.2, ctx.currentTime);

		master = ctx.createGain();
		master.gain.value = 0.9;
		master.connect(compressor);
		compressor.connect(ctx.destination);
	}
	if (ctx.state === 'suspended') {
		ctx.resume().catch(() => {});
	}
	return ctx;
}

export function initAudio() {
	ensureCtx();
}

function envelope(gain: GainNode, audio: AudioContext, peak: number, attack: number, decay: number) {
	const now = audio.currentTime;
	gain.gain.cancelScheduledValues(now);
	gain.gain.setValueAtTime(0.0001, now);
	gain.gain.linearRampToValueAtTime(peak, now + attack);
	gain.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);
}

// thins out and quiets a sound type once too many of it are firing in a short window,
// so a big pile of simultaneous collisions doesn't turn into a wall of noise
const voiceWindows = new Map<string, number[]>();
const VOICE_WINDOW_MS = 120;
const VOICE_FULL_VOLUME_COUNT = 3;
const VOICE_HARD_CAP = 10;

function voiceGainScale(key: string): number {
	const now = performance.now();
	let times = voiceWindows.get(key);
	if (!times) {
		times = [];
		voiceWindows.set(key, times);
	}
	while (times.length && now - times[0] > VOICE_WINDOW_MS) times.shift();
	if (times.length >= VOICE_HARD_CAP) return 0;
	times.push(now);
	const count = times.length;
	return count <= VOICE_FULL_VOLUME_COUNT ? 1 : VOICE_FULL_VOLUME_COUNT / count;
}

export function playBounce(intensity = 1) {
	const audio = ensureCtx();
	if (!audio || !master) return;
	const scale = voiceGainScale('bounce');
	if (scale <= 0) return;
	const clamped = Math.min(Math.max(intensity, 0), 1);

	const osc = audio.createOscillator();
	const gain = audio.createGain();
	osc.type = 'sine';
	const baseFreq = 90 + clamped * 70;
	osc.frequency.setValueAtTime(baseFreq, audio.currentTime);
	osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.55, audio.currentTime + 0.12);
	osc.connect(gain);
	gain.connect(master);
	envelope(gain, audio, (0.08 + clamped * 0.22) * scale, 0.002, 0.14);
	osc.start();
	osc.stop(audio.currentTime + 0.2);
}

export function playGrab() {
	const audio = ensureCtx();
	if (!audio || !master) return;
	const scale = voiceGainScale('grab');
	if (scale <= 0) return;

	const osc = audio.createOscillator();
	const gain = audio.createGain();
	osc.type = 'triangle';
	osc.frequency.setValueAtTime(300, audio.currentTime);
	osc.frequency.exponentialRampToValueAtTime(420, audio.currentTime + 0.05);
	osc.connect(gain);
	gain.connect(master);
	envelope(gain, audio, 0.1 * scale, 0.002, 0.06);
	osc.start();
	osc.stop(audio.currentTime + 0.08);
}

export function playRelease() {
	const audio = ensureCtx();
	if (!audio || !master) return;
	const scale = voiceGainScale('release');
	if (scale <= 0) return;

	const osc = audio.createOscillator();
	const gain = audio.createGain();
	osc.type = 'triangle';
	osc.frequency.setValueAtTime(260, audio.currentTime);
	osc.frequency.exponentialRampToValueAtTime(170, audio.currentTime + 0.08);
	osc.connect(gain);
	gain.connect(master);
	envelope(gain, audio, 0.09 * scale, 0.002, 0.09);
	osc.start();
	osc.stop(audio.currentTime + 0.12);
}

export function playPop() {
	const audio = ensureCtx();
	if (!audio || !master) return;
	const scale = voiceGainScale('pop');
	if (scale <= 0) return;

	const bufferSize = Math.floor(audio.sampleRate * 0.15);
	const buffer = audio.createBuffer(1, bufferSize, audio.sampleRate);
	const data = buffer.getChannelData(0);
	for (let i = 0; i < bufferSize; i++) {
		data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
	}

	const noise = audio.createBufferSource();
	noise.buffer = buffer;

	const noiseFilter = audio.createBiquadFilter();
	noiseFilter.type = 'bandpass';
	noiseFilter.frequency.setValueAtTime(1800, audio.currentTime);
	noiseFilter.frequency.exponentialRampToValueAtTime(500, audio.currentTime + 0.1);
	noiseFilter.Q.value = 0.8;

	const noiseGain = audio.createGain();
	envelope(noiseGain, audio, 0.28 * scale, 0.001, 0.12);

	noise.connect(noiseFilter);
	noiseFilter.connect(noiseGain);
	noiseGain.connect(master);
	noise.start();
	noise.stop(audio.currentTime + 0.15);

	const osc = audio.createOscillator();
	const oscGain = audio.createGain();
	osc.type = 'sine';
	osc.frequency.setValueAtTime(700, audio.currentTime);
	osc.frequency.exponentialRampToValueAtTime(200, audio.currentTime + 0.08);
	osc.connect(oscGain);
	oscGain.connect(master);
	envelope(oscGain, audio, 0.18 * scale, 0.001, 0.08);
	osc.start();
	osc.stop(audio.currentTime + 0.1);
}

export function playSpawn() {
	const audio = ensureCtx();
	if (!audio || !master) return;
	const scale = voiceGainScale('spawn');
	if (scale <= 0) return;

	const osc = audio.createOscillator();
	const gain = audio.createGain();
	osc.type = 'sine';
	osc.frequency.setValueAtTime(220, audio.currentTime);
	osc.frequency.exponentialRampToValueAtTime(660, audio.currentTime + 0.14);
	osc.connect(gain);
	gain.connect(master);
	envelope(gain, audio, 0.16 * scale, 0.005, 0.16);
	osc.start();
	osc.stop(audio.currentTime + 0.2);

	const shimmer = audio.createOscillator();
	const shimmerGain = audio.createGain();
	shimmer.type = 'triangle';
	shimmer.frequency.setValueAtTime(880, audio.currentTime + 0.05);
	shimmer.frequency.exponentialRampToValueAtTime(1320, audio.currentTime + 0.18);
	shimmer.connect(shimmerGain);
	shimmerGain.connect(master);
	envelope(shimmerGain, audio, 0.06 * scale, 0.05, 0.12);
	shimmer.start(audio.currentTime + 0.05);
	shimmer.stop(audio.currentTime + 0.22);
}
