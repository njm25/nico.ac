import Matter from 'matter-js';

const { Bodies, Body, Composite, Engine, Sleeping } = Matter;

// One Matter world, in viewport pixels, shared by the gun (which fills it with
// shot letters) and the beach balls (which push those letters around).
export interface LetterSpawn {
	el: HTMLElement;
	x: number;
	y: number;
	width: number;
	height: number;
	vx: number;
	vy: number;
	spin: number;
}

// a beach ball mirrored into this world; all values in viewport pixels per step
export interface BallState {
	id: number;
	x: number;
	y: number;
	radius: number;
	vx: number;
	vy: number;
	spin: number;
}

interface Letter {
	el: HTMLElement;
	body: Matter.Body;
	settled: boolean;
	width: number;
	height: number;
}

const WALL = 400;
const STEP = 1000 / 60;
const MAX_STEPS_PER_FRAME = 4;
const MAX_LETTERS = 700;

let engine: Matter.Engine | null = null;
let bounds: Matter.Body[] = [];
const letters: Letter[] = [];
const ballBodies = new Map<number, Matter.Body>();

let running = false;
let rafId = 0;
let lastTime = 0;
let accumulator = 0;

export function ensurePhysics(): Matter.Engine {
	if (engine) return engine;
	// sleeping matters here: piles are permanent, so settled letters cost nothing
	engine = Engine.create({ enableSleeping: true });
	engine.gravity.y = 1;
	rebuildBounds();
	return engine;
}

export function rebuildBounds() {
	if (!engine) return;
	if (bounds.length) Composite.remove(engine.world, bounds);

	const w = window.innerWidth;
	const h = window.innerHeight;
	const options = { isStatic: true, restitution: 0.1, friction: 0.6 };

	// thick, so a fast letter cannot tunnel through
	bounds = [
		Bodies.rectangle(w / 2, h + WALL / 2, w + WALL * 2, WALL, options),
		Bodies.rectangle(-WALL / 2, h / 2, WALL, h * 3, options),
		Bodies.rectangle(w + WALL / 2, h / 2, WALL, h * 3, options),
	];
	Composite.add(engine.world, bounds);
}

export function letterCount(): number {
	return letters.length;
}

export function addLetters(spawns: LetterSpawn[]) {
	if (!spawns.length) return;
	const world = ensurePhysics().world;

	for (const spawn of spawns) {
		const body = Bodies.rectangle(spawn.x, spawn.y, spawn.width, spawn.height, {
			restitution: 0.18,
			friction: 0.55,
			frictionAir: 0.012,
			density: 0.0016,
		});
		Body.setVelocity(body, { x: spawn.vx, y: spawn.vy });
		Body.setAngularVelocity(body, spawn.spin);

		Composite.add(world, body);
		letters.push({
			el: spawn.el,
			body,
			settled: false,
			width: spawn.width,
			height: spawn.height,
		});
	}

	cull();
	syncLetters();
	startLoop();
}

// a blast near the pile: wake anything in range and throw it outward
export function shoveLetters(x: number, y: number, radius: number) {
	if (!letters.length) return;
	let disturbed = false;

	for (const letter of letters) {
		const dx = letter.body.position.x - x;
		const dy = letter.body.position.y - y;
		const distance = Math.hypot(dx, dy);
		if (distance > radius) continue;

		const falloff = 1 - distance / radius;
		const spread = distance < 0.5 ? Math.random() * Math.PI * 2 : Math.atan2(dy, dx);
		const speed = (4 + falloff * 15) * (0.7 + Math.random() * 0.6);

		// setVelocity alone will not rouse a sleeping body
		Sleeping.set(letter.body, false);
		Body.setVelocity(letter.body, {
			x: Math.cos(spread) * speed,
			y: Math.sin(spread) * speed - falloff * 6,
		});
		Body.setAngularVelocity(letter.body, (Math.random() - 0.5) * 0.3);
		letter.settled = false;
		disturbed = true;
	}

	if (disturbed) startLoop();
}

// rouse settled letters in a patch of the world, so gravity picks them up again
// once whatever was holding them up has gone
function wakeNear(x: number, y: number, radius: number) {
	if (radius <= 0) return;
	let woken = false;

	for (const letter of letters) {
		if (!letter.body.isSleeping) continue;
		const dx = letter.body.position.x - x;
		const dy = letter.body.position.y - y;
		if (Math.hypot(dx, dy) > radius) continue;

		Sleeping.set(letter.body, false);
		letter.settled = false;
		woken = true;
	}

	if (woken) startLoop();
}

export function wakeLetters() {
	for (const letter of letters) {
		Sleeping.set(letter.body, false);
		letter.settled = false;
	}
	if (letters.length) startLoop();
}

export function clearLetters() {
	if (engine && letters.length) {
		Composite.remove(
			engine.world,
			letters.map((l) => l.body)
		);
	}
	letters.length = 0;
	stopLoop();
}

/* ------------------------------------------------------------ ball bridge */

// Mirrors the beach balls in as heavy proxy circles. Their state is overwritten
// from the three.js simulation every frame, so balls shove letters but letters
// never move a ball - which is about right when a ball outweighs a letter ~35x.
export function syncBalls(balls: BallState[]) {
	if (!engine) return;

	const seen = new Set<number>();

	for (const ball of balls) {
		seen.add(ball.id);
		let body = ballBodies.get(ball.id);

		if (!body || Math.abs(body.circleRadius! - ball.radius) > 0.5) {
			if (body) Composite.remove(engine.world, body);
			body = Bodies.circle(ball.x, ball.y, ball.radius, {
				density: 0.05,
				friction: 0.6,
				frictionAir: 0,
				restitution: 0.4,
			});
			Composite.add(engine.world, body);
			ballBodies.set(ball.id, body);
		}

		// a ball sliding out from under resting letters removes their support
		// without ever colliding with them, so nothing would wake them
		const prevX = body.position.x;
		const prevY = body.position.y;

		Sleeping.set(body, false);
		Body.setPosition(body, { x: ball.x, y: ball.y });
		Body.setVelocity(body, { x: ball.vx, y: ball.vy });
		Body.setAngularVelocity(body, ball.spin);

		if (Math.hypot(ball.x - prevX, ball.y - prevY) > 0.5) {
			wakeNear(prevX, prevY, ball.radius * 1.5);
		}
	}

	// a popped ball leaves anything stacked on it floating in mid air
	for (const [id, body] of ballBodies) {
		if (seen.has(id)) continue;
		wakeNear(body.position.x, body.position.y, (body.circleRadius ?? 0) * 3);
		Composite.remove(engine.world, body);
		ballBodies.delete(id);
	}

	if (letters.length && balls.length) startLoop();
}

/* ------------------------------------------------------------------ loop */

function startLoop() {
	if (running) return;
	running = true;
	lastTime = 0;
	accumulator = 0;
	rafId = requestAnimationFrame(frame);
}

function stopLoop() {
	running = false;
	cancelAnimationFrame(rafId);
}

function frame(now: number) {
	if (!running) return;
	rafId = requestAnimationFrame(frame);

	if (!lastTime) lastTime = now;
	accumulator += Math.min(now - lastTime, 100);
	lastTime = now;

	let steps = 0;
	while (accumulator >= STEP && steps < MAX_STEPS_PER_FRAME) {
		Engine.update(engine!, STEP);
		accumulator -= STEP;
		steps++;
	}
	if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;

	syncLetters();

	// park once everything rests and no ball is around to disturb it
	if (!ballBodies.size && letters.every((l) => l.settled)) stopLoop();
}

function syncLetters() {
	for (const letter of letters) {
		if (letter.body.isSleeping && letter.settled) continue;

		const { x, y } = letter.body.position;
		letter.el.style.transform =
			`translate(${x - letter.width / 2}px, ${y - letter.height / 2}px) rotate(${letter.body.angle}rad)`;
		letter.settled = letter.body.isSleeping;
	}
}

function cull() {
	const excess = letters.length - MAX_LETTERS;
	if (excess <= 0) return;

	for (const letter of letters.splice(0, excess)) {
		Composite.remove(engine!.world, letter.body);
		letter.el.classList.add('fading');
		setTimeout(() => letter.el.remove(), 400);
	}
}
