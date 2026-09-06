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

function noiseBuffer(audio: AudioContext, seconds: number, decay: number): AudioBuffer {
	const length = Math.floor(audio.sampleRate * seconds);
	const buffer = audio.createBuffer(1, length, audio.sampleRate);
	const data = buffer.getChannelData(0);
	for (let i = 0; i < length; i++) {
		data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
	}
	return buffer;
}

// the rifle report is brighter and much shorter: it has to repeat ten times a
// second without smearing into a single wall of low end
const SHOT_PROFILES = {
	pistol: {
		peak: 0.5,
		open: 9000,
		close: 600,
		sweep: 0.18,
		decay: 0.22,
		bodyFrom: 120,
		bodyTo: 42,
		bodyPeak: 0.34,
		bodyDecay: 0.18,
		tail: 0.07,
	},
	rpg: {
		peak: 0.34,
		open: 4200,
		close: 260,
		sweep: 0.3,
		decay: 0.36,
		bodyFrom: 210,
		bodyTo: 60,
		bodyPeak: 0.26,
		bodyDecay: 0.3,
		tail: 0.06,
	},
	explosion: {
		peak: 0.6,
		open: 5200,
		close: 150,
		sweep: 0.42,
		decay: 0.6,
		bodyFrom: 80,
		bodyTo: 22,
		bodyPeak: 0.55,
		bodyDecay: 0.5,
		tail: 0.16,
	},
	shotgun: {
		peak: 0.55,
		open: 7000,
		close: 380,
		sweep: 0.24,
		decay: 0.32,
		bodyFrom: 100,
		bodyTo: 32,
		bodyPeak: 0.44,
		bodyDecay: 0.26,
		tail: 0.11,
	},
	rifle: {
		peak: 0.4,
		open: 13000,
		close: 1100,
		sweep: 0.09,
		decay: 0.12,
		bodyFrom: 165,
		bodyTo: 70,
		bodyPeak: 0.2,
		bodyDecay: 0.09,
		tail: 0.04,
	},
} as const;

export function playGunshot(profile: keyof typeof SHOT_PROFILES = 'pistol') {
	const audio = ensureCtx();
	if (!audio || !master) return;
	const scale = voiceGainScale('gunshot');
	if (scale <= 0) return;
	const now = audio.currentTime;
	const shot = SHOT_PROFILES[profile];

	// crack: bright noise burst swept down hard, the part that reads as "gun"
	const crack = audio.createBufferSource();
	crack.buffer = noiseBuffer(audio, 0.3, 2.5);

	const crackFilter = audio.createBiquadFilter();
	crackFilter.type = 'lowpass';
	crackFilter.frequency.setValueAtTime(shot.open, now);
	crackFilter.frequency.exponentialRampToValueAtTime(shot.close, now + shot.sweep);
	crackFilter.Q.value = 1.2;

	const crackGain = audio.createGain();
	envelope(crackGain, audio, shot.peak * scale, 0.001, shot.decay);

	crack.connect(crackFilter);
	crackFilter.connect(crackGain);
	crackGain.connect(master);
	crack.start(now);
	crack.stop(now + 0.32);

	// body: low thump so it has weight on decent speakers
	const body = audio.createOscillator();
	const bodyGain = audio.createGain();
	body.type = 'sine';
	body.frequency.setValueAtTime(shot.bodyFrom, now);
	body.frequency.exponentialRampToValueAtTime(shot.bodyTo, now + shot.bodyDecay);
	body.connect(bodyGain);
	bodyGain.connect(master);
	envelope(bodyGain, audio, shot.bodyPeak * scale, 0.001, shot.bodyDecay);
	body.start(now);
	body.stop(now + 0.24);

	// tail: quiet room slap a beat after the crack
	const tail = audio.createBufferSource();
	tail.buffer = noiseBuffer(audio, 0.25, 1.2);

	const tailFilter = audio.createBiquadFilter();
	tailFilter.type = 'bandpass';
	tailFilter.frequency.value = 1100;
	tailFilter.Q.value = 0.6;

	const tailGain = audio.createGain();
	const tailStart = now + 0.05;
	tailGain.gain.setValueAtTime(0.0001, tailStart);
	tailGain.gain.linearRampToValueAtTime(shot.tail * scale, tailStart + 0.01);
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

	// two dry clicks: slide back, slide forward
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

	const noise = audio.createBufferSource();
	noise.buffer = noiseBuffer(audio, 0.18, 1.6);

	const filter = audio.createBiquadFilter();
	filter.type = 'lowpass';
	filter.frequency.setValueAtTime(1400, audio.currentTime);
	filter.frequency.exponentialRampToValueAtTime(400, audio.currentTime + 0.16);

	const gain = audio.createGain();
	envelope(gain, audio, 0.1 * scale, 0.004, 0.16);

	noise.connect(filter);
	filter.connect(gain);
	gain.connect(master);
	noise.start();
	noise.stop(audio.currentTime + 0.2);
}

let sprayNoise: AudioBufferSourceNode | null = null;
let sprayGain: GainNode | null = null;

// a continuous hiss for as long as the button is held, rather than a one-shot
export function startSprayHiss() {
	const audio = ensureCtx();
	if (!audio || !master || sprayNoise) return;

	const noise = audio.createBufferSource();
	noise.buffer = noiseBuffer(audio, 1, 0);
	noise.loop = true;

	const highpass = audio.createBiquadFilter();
	highpass.type = 'highpass';
	highpass.frequency.value = 1100;

	const bandpass = audio.createBiquadFilter();
	bandpass.type = 'bandpass';
	bandpass.frequency.value = 4300;
	bandpass.Q.value = 0.55;

	const gain = audio.createGain();
	gain.gain.setValueAtTime(0.0001, audio.currentTime);
	gain.gain.linearRampToValueAtTime(0.055, audio.currentTime + 0.05);

	noise.connect(highpass);
	highpass.connect(bandpass);
	bandpass.connect(gain);
	gain.connect(master);
	noise.start();

	sprayNoise = noise;
	sprayGain = gain;
}

export function stopSprayHiss() {
	const audio = ensureCtx();
	if (!audio || !sprayNoise || !sprayGain) return;

	const now = audio.currentTime;
	sprayGain.gain.cancelScheduledValues(now);
	sprayGain.gain.setValueAtTime(Math.max(sprayGain.gain.value, 0.0001), now);
	sprayGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
	sprayNoise.stop(now + 0.12);

	sprayNoise = null;
	sprayGain = null;
}

// the ball bearing rattling in the can
export function playShake() {
	const audio = ensureCtx();
	if (!audio || !master) return;
	const scale = voiceGainScale('shake');
	if (scale <= 0) return;
	const now = audio.currentTime;

	for (let i = 0; i < 3; i++) {
		const click = audio.createBufferSource();
		click.buffer = noiseBuffer(audio, 0.05, 5);

		const filter = audio.createBiquadFilter();
		filter.type = 'bandpass';
		filter.frequency.value = 2400 + Math.random() * 1800;
		filter.Q.value = 2.5;

		const gain = audio.createGain();
		const start = now + i * (0.055 + Math.random() * 0.03);
		gain.gain.setValueAtTime(0.0001, start);
		gain.gain.linearRampToValueAtTime(0.13 * scale, start + 0.002);
		gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.06);

		click.connect(filter);
		filter.connect(gain);
		gain.connect(master);
		click.start(start);
		click.stop(start + 0.09);
	}
}
