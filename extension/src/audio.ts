// Lifted from the portfolio sandbox: a small web audio synth, no samples to ship.
let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function ensureCtx(): AudioContext | null {
	if (typeof window === 'undefined') return null;
	if (!ctx) {
		const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
		if (!AudioCtx) return null;
		ctx = new AudioCtx();

		// master limiter so a burst of shots cannot clip
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
	if (ctx.state === 'suspended') ctx.resume().catch(() => {});
	return ctx;
}

export function initAudio() {
	ensureCtx();
}

// thins out a sound once too many of it fire in a short window
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
	return times.length <= VOICE_FULL_VOLUME_COUNT ? 1 : VOICE_FULL_VOLUME_COUNT / times.length;
}

function noiseBuffer(audio: AudioContext, seconds: number, decay: number): AudioBuffer {
	const length = Math.floor(audio.sampleRate * seconds);
	const buffer = audio.createBuffer(1, length, audio.sampleRate);
	const data = buffer.getChannelData(0);
	for (let i = 0; i < length; i++) {
		data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
	}
	return buffer;
}

export function playGunshot() {
	const audio = ensureCtx();
	if (!audio || !master) return;
	const scale = voiceGainScale('gunshot');
	if (scale <= 0) return;
	const now = audio.currentTime;

	// crack: bright noise swept down hard, the part that reads as "gun"
	const crack = audio.createBufferSource();
	crack.buffer = noiseBuffer(audio, 0.3, 2.5);

	const crackFilter = audio.createBiquadFilter();
	crackFilter.type = 'lowpass';
	crackFilter.frequency.setValueAtTime(9000, now);
	crackFilter.frequency.exponentialRampToValueAtTime(600, now + 0.18);
	crackFilter.Q.value = 1.2;

	const crackGain = audio.createGain();
	crackGain.gain.setValueAtTime(0.0001, now);
	crackGain.gain.linearRampToValueAtTime(0.5 * scale, now + 0.001);
	crackGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

	crack.connect(crackFilter);
	crackFilter.connect(crackGain);
	crackGain.connect(master);
	crack.start(now);
	crack.stop(now + 0.32);

	// body: low thump so it has weight
	const body = audio.createOscillator();
	const bodyGain = audio.createGain();
	body.type = 'sine';
	body.frequency.setValueAtTime(120, now);
	body.frequency.exponentialRampToValueAtTime(42, now + 0.16);
	bodyGain.gain.setValueAtTime(0.0001, now);
	bodyGain.gain.linearRampToValueAtTime(0.34 * scale, now + 0.001);
	bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
	body.connect(bodyGain);
	bodyGain.connect(master);
	body.start(now);
	body.stop(now + 0.24);

	// tail: quiet room slap a beat later
	const tail = audio.createBufferSource();
	tail.buffer = noiseBuffer(audio, 0.25, 1.2);
	const tailFilter = audio.createBiquadFilter();
	tailFilter.type = 'bandpass';
	tailFilter.frequency.value = 1100;
	tailFilter.Q.value = 0.6;
	const tailGain = audio.createGain();
	const tailStart = now + 0.05;
	tailGain.gain.setValueAtTime(0.0001, tailStart);
	tailGain.gain.linearRampToValueAtTime(0.07 * scale, tailStart + 0.01);
	tailGain.gain.exponentialRampToValueAtTime(0.0001, tailStart + 0.22);
	tail.connect(tailFilter);
	tailFilter.connect(tailGain);
	tailGain.connect(master);
	tail.start(tailStart);
	tail.stop(tailStart + 0.26);
}

export function playCock() {
	const audio = ensureCtx();
	if (!audio || !master) return;
	const scale = voiceGainScale('cock');
	if (scale <= 0) return;
	const now = audio.currentTime;

	for (const [offset, freq, peak] of [
		[0, 2600, 0.12],
		[0.09, 1900, 0.16],
	] as const) {
		const click = audio.createBufferSource();
		click.buffer = noiseBuffer(audio, 0.04, 6);

		const filter = audio.createBiquadFilter();
		filter.type = 'bandpass';
		filter.frequency.value = freq;
		filter.Q.value = 3;

		const gain = audio.createGain();
		const start = now + offset;
		gain.gain.setValueAtTime(0.0001, start);
		gain.gain.linearRampToValueAtTime(peak * scale, start + 0.001);
		gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.05);

		click.connect(filter);
		filter.connect(gain);
		gain.connect(master);
		click.start(start);
		click.stop(start + 0.06);
	}
}

export function playHolster() {
	const audio = ensureCtx();
	if (!audio || !master) return;
	const scale = voiceGainScale('holster');
	if (scale <= 0) return;
	const now = audio.currentTime;

	const noise = audio.createBufferSource();
	noise.buffer = noiseBuffer(audio, 0.18, 1.6);

	const filter = audio.createBiquadFilter();
	filter.type = 'lowpass';
	filter.frequency.setValueAtTime(1400, now);
	filter.frequency.exponentialRampToValueAtTime(400, now + 0.16);

	const gain = audio.createGain();
	gain.gain.setValueAtTime(0.0001, now);
	gain.gain.linearRampToValueAtTime(0.1 * scale, now + 0.004);
	gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

	noise.connect(filter);
	filter.connect(gain);
	gain.connect(master);
	noise.start(now);
	noise.stop(now + 0.2);
}
