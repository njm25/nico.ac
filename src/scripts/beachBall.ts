import * as THREE from 'three';

interface Ball {
	mesh: THREE.Mesh;
	velocity: THREE.Vector3;
	angularVelocity: THREE.Vector3;
	radius: number;
	dragging: boolean;
}

const GRAVITY = -9.8;
const RESTITUTION = 0.62;
const GROUND_FRICTION = 0.985;
const AIR_DAMPING = 0.999;
const MAX_DT = 1 / 30;
const BALL_RADIUS = 0.55;
const DRAG_THRESHOLD = 6;

let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let canvas: HTMLCanvasElement | null = null;
let ballTexture: THREE.CanvasTexture | null = null;
let clock: THREE.Clock | null = null;
let animating = false;

const balls: Ball[] = [];
const particles: { mesh: THREE.Mesh; velocity: THREE.Vector3; life: number }[] = [];

let dragTarget: Ball | null = null;
let pointerDownPos = { x: 0, y: 0 };
let pointerMoved = 0;
let lastPointerWorld = new THREE.Vector3();
let lastPointerTime = 0;
let dragPlaneZ = 0;

function showErrorBanner(message: string) {
	const banner = document.createElement('div');
	banner.textContent = `sandbox error: ${message}`;
	banner.style.cssText =
		'position:fixed;left:1.25rem;bottom:1.25rem;z-index:99999;background:var(--bg-raised,#101216);' +
		'color:var(--text,#d7dbe0);border:1px solid var(--border,#1d2027);border-radius:4px;' +
		'padding:0.6rem 0.9rem;font-family:var(--mono,monospace);font-size:0.8rem;max-width:280px;';
	document.body.appendChild(banner);
	setTimeout(() => banner.remove(), 6000);
}

function makeBeachBallTexture(): THREE.CanvasTexture {
	const size = 512;
	const c = document.createElement('canvas');
	c.width = size;
	c.height = size / 2;
	const ctx = c.getContext('2d')!;

	const colors = ['#e64545', '#f2a93b', '#f4e04d', '#4caf7c', '#4a90d9'];
	const panelCount = colors.length * 2;
	const panelWidth = size / panelCount;

	for (let i = 0; i < panelCount; i++) {
		ctx.fillStyle = i % 2 === 0 ? colors[(i / 2) % colors.length] : '#f2f2ef';
		ctx.fillRect(i * panelWidth, 0, panelWidth, c.height);
	}

	const capHeight = c.height * 0.14;
	ctx.fillStyle = '#f2f2ef';
	ctx.fillRect(0, 0, size, capHeight);
	ctx.fillRect(0, c.height - capHeight, size, capHeight);

	const texture = new THREE.CanvasTexture(c);
	texture.wrapS = THREE.RepeatWrapping;
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;
}

function ensureScene() {
	if (renderer) return;

	canvas = document.createElement('canvas');
	canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:-1;';
	document.body.appendChild(canvas);

	renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	renderer.setSize(window.innerWidth, window.innerHeight);

	scene = new THREE.Scene();

	camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
	camera.position.set(0, 0, 10);

	const ambient = new THREE.AmbientLight(0xffffff, 0.7);
	const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
	dirLight.position.set(3, 5, 6);
	scene.add(ambient, dirLight);

	ballTexture = makeBeachBallTexture();
	clock = new THREE.Clock();

	window.addEventListener('resize', onResize);
	window.addEventListener('pointerdown', onPointerDown, { capture: true });
	window.addEventListener('pointermove', onPointerMove, { capture: true });
	window.addEventListener('pointerup', onPointerUp, { capture: true });
}

function onResize() {
	if (!camera || !renderer) return;
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize(window.innerWidth, window.innerHeight);
}

function getVisibleBounds() {
	const distance = camera!.position.z;
	const vFov = (camera!.fov * Math.PI) / 180;
	const height = 2 * Math.tan(vFov / 2) * distance;
	const width = height * camera!.aspect;
	return { halfWidth: width / 2, halfHeight: height / 2 };
}

function worldFromScreen(x: number, y: number, z: number): THREE.Vector3 {
	const ndc = new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
	const vector = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(camera!);
	const dir = vector.sub(camera!.position).normalize();
	const distance = (z - camera!.position.z) / dir.z;
	return camera!.position.clone().add(dir.multiplyScalar(distance));
}

function raycastBalls(x: number, y: number): Ball | null {
	const ndc = new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
	const raycaster = new THREE.Raycaster();
	raycaster.setFromCamera(ndc, camera!);
	const meshes = balls.map((b) => b.mesh);
	const hits = raycaster.intersectObjects(meshes);
	if (!hits.length) return null;
	const hitMesh = hits[0].object;
	return balls.find((b) => b.mesh === hitMesh) ?? null;
}

function onPointerDown(e: PointerEvent) {
	if (!balls.length) return;
	const hit = raycastBalls(e.clientX, e.clientY);
	if (!hit) return;

	e.preventDefault();
	e.stopPropagation();

	dragTarget = hit;
	hit.dragging = true;
	hit.velocity.set(0, 0, 0);
	hit.angularVelocity.set(0, 0, 0);
	pointerDownPos = { x: e.clientX, y: e.clientY };
	pointerMoved = 0;
	dragPlaneZ = hit.mesh.position.z;
	lastPointerWorld = worldFromScreen(e.clientX, e.clientY, dragPlaneZ);
	lastPointerTime = performance.now();
}

function onPointerMove(e: PointerEvent) {
	if (!dragTarget) return;
	e.preventDefault();
	e.stopPropagation();

	pointerMoved += Math.hypot(e.movementX || 0, e.movementY || 0);

	const world = worldFromScreen(e.clientX, e.clientY, dragPlaneZ);
	dragTarget.mesh.position.copy(world);

	const now = performance.now();
	const dt = Math.max((now - lastPointerTime) / 1000, 1 / 120);
	dragTarget.velocity.copy(world).sub(lastPointerWorld).divideScalar(dt);
	lastPointerWorld = world;
	lastPointerTime = now;
}

function onPointerUp(e: PointerEvent) {
	if (!dragTarget) return;
	e.preventDefault();
	e.stopPropagation();

	const ball = dragTarget;
	dragTarget = null;
	ball.dragging = false;

	if (pointerMoved < DRAG_THRESHOLD) {
		popBall(ball);
	} else {
		ball.velocity.clampLength(0, 14);
		ball.angularVelocity.set(
			-ball.velocity.y * 0.6,
			ball.velocity.x * 0.6,
			(Math.random() - 0.5) * 2
		);
	}
}

function popBall(ball: Ball) {
	const index = balls.indexOf(ball);
	if (index === -1) return;
	balls.splice(index, 1);

	const position = ball.mesh.position.clone();
	scene!.remove(ball.mesh);
	ball.mesh.geometry.dispose();
	(ball.mesh.material as THREE.Material).dispose();

	const particleCount = 10;
	for (let i = 0; i < particleCount; i++) {
		const geometry = new THREE.SphereGeometry(0.04 + Math.random() * 0.03, 6, 6);
		const material = new THREE.MeshBasicMaterial({
			color: new THREE.Color().setHSL(Math.random(), 0.7, 0.6),
			transparent: true,
		});
		const mesh = new THREE.Mesh(geometry, material);
		mesh.position.copy(position);
		scene!.add(mesh);

		const angle = Math.random() * Math.PI * 2;
		const speed = 2 + Math.random() * 3;
		particles.push({
			mesh,
			velocity: new THREE.Vector3(Math.cos(angle) * speed, Math.random() * speed + 1, (Math.random() - 0.5) * speed),
			life: 0.6 + Math.random() * 0.3,
		});
	}
}

function stepPhysics(dt: number) {
	const { halfWidth, halfHeight } = getVisibleBounds();
	const floorY = -halfHeight + BALL_RADIUS;

	for (const ball of balls) {
		if (ball.dragging) continue;

		ball.velocity.y += GRAVITY * dt;
		ball.velocity.multiplyScalar(AIR_DAMPING);
		ball.mesh.position.addScaledVector(ball.velocity, dt);

		if (ball.mesh.position.y <= floorY) {
			ball.mesh.position.y = floorY;
			if (ball.velocity.y < 0) ball.velocity.y = -ball.velocity.y * RESTITUTION;
			ball.velocity.x *= GROUND_FRICTION;
			ball.velocity.z *= GROUND_FRICTION;
			if (Math.abs(ball.velocity.y) < 0.05) ball.velocity.y = 0;
		}

		const leftBound = -halfWidth + BALL_RADIUS;
		const rightBound = halfWidth - BALL_RADIUS;
		if (ball.mesh.position.x <= leftBound) {
			ball.mesh.position.x = leftBound;
			ball.velocity.x = -ball.velocity.x * RESTITUTION;
		} else if (ball.mesh.position.x >= rightBound) {
			ball.mesh.position.x = rightBound;
			ball.velocity.x = -ball.velocity.x * RESTITUTION;
		}

		ball.angularVelocity.multiplyScalar(0.98);
		if (ball.angularVelocity.lengthSq() > 0.0001) {
			ball.mesh.rotateOnWorldAxis(new THREE.Vector3(1, 0, 0), ball.angularVelocity.x * dt);
			ball.mesh.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), ball.angularVelocity.y * dt);
			ball.mesh.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), ball.angularVelocity.z * dt);
		} else {
			const speed = Math.hypot(ball.velocity.x, ball.velocity.y);
			if (speed > 0.01) {
				ball.mesh.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), (-ball.velocity.x / BALL_RADIUS) * dt);
				ball.mesh.rotateOnWorldAxis(new THREE.Vector3(1, 0, 0), (ball.velocity.y / BALL_RADIUS) * dt);
			}
		}
	}

	resolveBallCollisions();

	for (let i = particles.length - 1; i >= 0; i--) {
		const p = particles[i];
		p.velocity.y += GRAVITY * 0.5 * dt;
		p.mesh.position.addScaledVector(p.velocity, dt);
		p.life -= dt;
		(p.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(p.life, 0);
		if (p.life <= 0) {
			scene!.remove(p.mesh);
			p.mesh.geometry.dispose();
			(p.mesh.material as THREE.Material).dispose();
			particles.splice(i, 1);
		}
	}
}

const BALL_RESTITUTION = 0.85;

function resolveBallCollisions() {
	for (let i = 0; i < balls.length; i++) {
		for (let j = i + 1; j < balls.length; j++) {
			const a = balls[i];
			const b = balls[j];
			if (a.dragging && b.dragging) continue;

			const delta = b.mesh.position.clone().sub(a.mesh.position);
			const dist = delta.length();
			const minDist = a.radius + b.radius;
			if (dist <= 0 || dist >= minDist) continue;

			const normal = delta.divideScalar(dist);
			const overlap = minDist - dist;

			if (a.dragging || b.dragging) {
				const anchor = a.dragging ? a : b;
				const other = a.dragging ? b : a;
				// unit vector pointing from the anchor (dragged ball) to the other ball
				const nAO = anchor === a ? normal.clone() : normal.clone().negate();

				other.mesh.position.addScaledVector(nAO, overlap);

				const approachSpeed = anchor.velocity.clone().sub(other.velocity).dot(nAO);
				if (approachSpeed > 0) {
					other.velocity.addScaledVector(nAO, approachSpeed * BALL_RESTITUTION);
				}
				continue;
			}

			const correction = normal.clone().multiplyScalar(overlap / 2);
			a.mesh.position.sub(correction);
			b.mesh.position.add(correction);

			const relVel = a.velocity.clone().sub(b.velocity);
			const speedAlongNormal = relVel.dot(normal);
			if (speedAlongNormal <= 0) continue;

			const impulse = normal.clone().multiplyScalar(speedAlongNormal * BALL_RESTITUTION);
			a.velocity.sub(impulse);
			b.velocity.add(impulse);
		}
	}
}

function animate() {
	if (!animating) return;
	requestAnimationFrame(animate);

	const dt = Math.min(clock!.getDelta(), MAX_DT);
	stepPhysics(dt);
	renderer!.render(scene!, camera!);

	if (!balls.length && !particles.length) {
		animating = false;
	}
}

function startAnimating() {
	if (animating) return;
	animating = true;
	clock!.getDelta();
	animate();
}

export function spawnBeachBall() {
	try {
		ensureScene();

		const geometry = new THREE.SphereGeometry(BALL_RADIUS, 32, 32);
		const material = new THREE.MeshStandardMaterial({ map: ballTexture, roughness: 0.5 });
		const mesh = new THREE.Mesh(geometry, material);

		const { halfWidth, halfHeight } = getVisibleBounds();
		mesh.position.set((Math.random() - 0.5) * halfWidth, halfHeight + BALL_RADIUS * 2, 0);
		mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);

		scene!.add(mesh);
		balls.push({
			mesh,
			velocity: new THREE.Vector3((Math.random() - 0.5) * 1.5, 0, 0),
			angularVelocity: new THREE.Vector3(),
			radius: BALL_RADIUS,
			dragging: false,
		});

		startAnimating();
	} catch (err) {
		console.error('beach ball spawn failed', err);
		showErrorBanner(err instanceof Error ? err.message : String(err));
	}
}

export function clearBeachBalls() {
	dragTarget = null;
	for (const ball of [...balls]) {
		scene?.remove(ball.mesh);
		ball.mesh.geometry.dispose();
		(ball.mesh.material as THREE.Material).dispose();
	}
	balls.length = 0;

	for (const p of [...particles]) {
		scene?.remove(p.mesh);
		p.mesh.geometry.dispose();
		(p.mesh.material as THREE.Material).dispose();
	}
	particles.length = 0;
}
