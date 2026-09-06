import type { LetterSpawn } from './letterPhysics';

// Finding text to destroy on an arbitrary page. The portfolio version wrapped
// every character on the page in a span up front - fine for 2,400 characters,
// fatal on a page with 100,000. Here nothing is touched until a shot lands:
// sample the elements under the blast, measure their characters with a Range,
// and split out only the ones actually hit.

const SAMPLE_POINTS = 10;
const MAX_CHARS_PER_SHOT = 2500;

interface Wound {
	span: HTMLElement;
	glyph: string;
}

const wounds: Wound[] = [];

function elementsUnder(clientX: number, clientY: number, radius: number): Element[] {
	const found = new Set<Element>();

	const sample = (x: number, y: number) => {
		if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return;
		for (const el of document.elementsFromPoint(x, y)) {
			if (el === document.documentElement || el === document.body) continue;
			found.add(el);
		}
	};

	// centre plus two rings, so text sitting anywhere in the blast is reachable
	sample(clientX, clientY);
	for (const ring of [0.45, 0.9]) {
		for (let i = 0; i < SAMPLE_POINTS; i++) {
			const angle = (i / SAMPLE_POINTS) * Math.PI * 2;
			sample(clientX + Math.cos(angle) * radius * ring, clientY + Math.sin(angle) * radius * ring);
		}
	}

	return [...found];
}

function renderedGlyph(char: string, textTransform: string): string {
	if (textTransform === 'uppercase') return char.toUpperCase();
	if (textTransform === 'lowercase') return char.toLowerCase();
	return char;
}

function fontOf(style: CSSStyleDeclaration): string {
	// canvas wants a font shorthand without line-height
	return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

export function shatterAt(clientX: number, clientY: number, radius: number): LetterSpawn[] {
	const spawns: LetterSpawn[] = [];
	const range = document.createRange();
	const seen = new Set<Text>();
	let examined = 0;

	for (const element of elementsUnder(clientX, clientY, radius)) {
		// only elements holding text directly; the stack from elementsFromPoint
		// also contains every ancestor, which we do not want to walk into
		const style = getComputedStyle(element);
		if (style.visibility === 'hidden' || style.display === 'none') continue;

		const font = fontOf(style);
		const colour = style.color;
		const transform = style.textTransform;

		for (const child of Array.from(element.childNodes)) {
			if (child.nodeType !== Node.TEXT_NODE) continue;
			const node = child as Text;
			if (seen.has(node) || !node.data.trim()) continue;
			seen.add(node);

			// cheap rejection before measuring individual characters
			range.selectNodeContents(node);
			const bounds = range.getBoundingClientRect();
			if (!bounds.width && !bounds.height) continue;
			if (
				bounds.right < clientX - radius ||
				bounds.left > clientX + radius ||
				bounds.bottom < clientY - radius ||
				bounds.top > clientY + radius
			) {
				continue;
			}

			const hits: { index: number; x: number; y: number; width: number; height: number }[] = [];
			for (let i = 0; i < node.data.length; i++) {
				if (examined++ > MAX_CHARS_PER_SHOT) break;
				if (!node.data[i].trim()) continue;

				range.setStart(node, i);
				range.setEnd(node, i + 1);
				const rect = range.getBoundingClientRect();
				if (rect.width < 0.5 || rect.height < 0.5) continue;

				const cx = rect.left + rect.width / 2;
				const cy = rect.top + rect.height / 2;
				if (Math.hypot(cx - clientX, cy - clientY) > radius) continue;

				hits.push({ index: i, x: cx, y: cy, width: rect.width, height: rect.height });
			}

			// descending, so splitting one character cannot invalidate the
			// indices of the ones still to be cut out of the same node
			for (let i = hits.length - 1; i >= 0; i--) {
				const hit = hits[i];
				const glyph = renderedGlyph(node.data[hit.index], transform);
				const span = extract(node, hit.index);
				if (!span) continue;
				wounds.push({ span, glyph: node.data[hit.index] ?? glyph });

				const dx = hit.x - clientX;
				const dy = hit.y - clientY;
				const distance = Math.hypot(dx, dy);
				const falloff = 1 - distance / radius;
				const spread = distance < 0.5 ? Math.random() * Math.PI * 2 : Math.atan2(dy, dx);
				const speed = (5 + falloff * 20) * (0.7 + Math.random() * 0.6);

				spawns.push({
					glyph,
					font,
					colour,
					x: hit.x,
					y: hit.y,
					width: hit.width,
					height: hit.height,
					vx: Math.cos(spread) * speed,
					vy: Math.sin(spread) * speed - falloff * 7,
					spin: (Math.random() - 0.5) * 0.25,
				});
			}
		}
	}

	return spawns;
}

// cut one character out of a text node and leave a hidden span holding its box,
// so the surrounding text does not reflow into the gap
function extract(node: Text, index: number): HTMLElement | null {
	const parent = node.parentNode;
	if (!parent) return null;

	node.splitText(index + 1);
	const target = node.splitText(index);

	const span = document.createElement('span');
	span.className = 'pgs-shot';
	span.textContent = target.data;
	parent.replaceChild(span, target);
	return span;
}

export function restoreText() {
	for (const wound of wounds) {
		const parent = wound.span.parentNode;
		if (!parent) continue;
		parent.replaceChild(document.createTextNode(wound.glyph), wound.span);
		// rejoin the fragments so the node is not left shredded
		(parent as Element).normalize?.();
	}
	wounds.length = 0;
}

export function woundCount(): number {
	return wounds.length;
}
