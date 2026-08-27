// Dev-time verification: drive the overlay's drag interaction with a minimal
// fake DOM (showBox -> pointerdown/move/up -> saved position -> hide -> pill ->
// reopen -> dblclick reset). Not shipped.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

// --- minimal fake DOM -----------------------------------------------------
const storage = new Map();
const localStorageStub = {
	getItem: (k) => (storage.has(k) ? storage.get(k) : null),
	setItem: (k, v) => storage.set(k, String(v)),
	removeItem: (k) => storage.delete(k)
};

function makeElement(tag) {
	const el = {
		tagName: tag.toUpperCase(),
		children: [],
		dataset: {},
		style: {},
		attributes: new Map(),
		listeners: new Map(),
		textContent: "",
		innerHTML: "",
		title: "",
		offsetWidth: 220,
		offsetHeight: 96,
		parentNode: null,
		appendChild(child) {
			child.parentNode = el;
			el.children.push(child);
			return child;
		},
		remove() {
			if (el.parentNode !== null) {
				const list = el.parentNode.children;
				const i = list.indexOf(el);
				if (i !== -1) list.splice(i, 1);
				el.parentNode = null;
			}
		},
		setAttribute(name, value) {
			el.attributes.set(name, String(value));
			if (name === "data-position") el.style.cssText = positionCssFor(String(value));
		},
		removeAttribute(name) {
			el.attributes.delete(name);
		},
		toggleAttribute(name, force) {
			if (force === undefined ? !el.attributes.has(name) : force) el.attributes.set(name, "true");
			else el.attributes.delete(name);
			return el.attributes.has(name);
		},
		getBoundingClientRect() {
			return { left: 100, top: 80, width: el.offsetWidth, height: el.offsetHeight };
		},
		setPointerCapture() {},
		releasePointerCapture() {},
		addEventListener(type, fn) {
			const list = el.listeners.get(type) ?? [];
			list.push(fn);
			el.listeners.set(type, list);
		},
		fire(type, event) {
			for (const fn of el.listeners.get(type) ?? []) fn({ ...event, type });
		}
	};
	return el;
}

function positionCssFor(position) {
	if (position === "top-center") return "top:10px;left:50%;transform:translateX(-50%)";
	if (position === "bottom-right") return "bottom:10px;right:12px";
	return "top:10px;right:12px";
}

let styleTags = [];
const documentStub = {
	body: makeElement("body"),
	head: makeElement("head"),
	createElement: (tag) => makeElement(tag),
	querySelector: (selector) => (selector.includes("style[data-plugin-css") ? (styleTags[0] ?? null) : null)
};

let registration = null;
const loader = {
	load(r) {
		registration = r;
	}
};
const windowStub = { innerWidth: 1280, innerHeight: 800 };
const sandbox = {
	window: windowStub,
	document: documentStub,
	localStorage: localStorageStub,
	console,
	Symbol,
	Object,
	setInterval: () => 1,
	clearInterval: () => {},
	fetch: async () => ({
		ok: true,
		json: async () => ({
			exists: true,
			steps: 5,
			hasUsage: true,
			cost: 0.5,
			currency: "CNY",
			period: "peak",
			totals: { input: 1000, cacheRead: 2000, cacheWrite: 0, output: 500, total: 3500 },
			models: [{ model: "deepseek-v4-flash", input: 1000, cacheRead: 2000, cacheWrite: 0, output: 500, steps: 5, cost: 0.5 }],
			context: { usedTokens: 964000, contextWindow: 1000000, period: "peak", model: "deepseek-v4-flash", currency: "CNY", cost: 2.892 }
		})
	}),
	__ModuleLoader__: loader
};
sandbox.window.__ModuleLoader__ = loader;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const exportsObj = registration.factory(() => { throw new Error("require"); });

const sessions = {
	list: {
		getSnapshot: () => ({ current: "sess-1" }),
		subscribe: () => () => {}
	}
};
let disposer = null;
const fakeCtx = {
	effect(fn) {
		disposer = fn();
		return disposer;
	},
	get(name) {
		return name === "sessions" ? sessions : undefined;
	}
};

exportsObj.apply(fakeCtx, { position: "top-right", pollMs: 1000, visible: true });
// let the async poll/render settle
await new Promise((resolve) => setTimeout(resolve, 10));

// --- assertions -----------------------------------------------------------
const box = documentStub.body.children.find((c) => c.dataset.tokenUsageHud === "box");
if (!box) throw new Error("box not created");
const head = box.children.find((c) => c.dataset.tokenUsageHud === "head");
if (!head) throw new Error("head not created");

// 0. context line (对话框下方的上下文占用) rendered from the API response
const bodyEl = box.children.find((c) => c.dataset.tokenUsageHud === "body");
if (!bodyEl) throw new Error("body element not created");
console.log("body html:", JSON.stringify(bodyEl.innerHTML));
if (!bodyEl.innerHTML.includes("上下文 ~964k / 1M (96%)")) throw new Error("context occupancy line missing");
if (!bodyEl.innerHTML.includes("≈¥2.89")) throw new Error("context cost missing");
if (!bodyEl.innerHTML.includes("[deepseek-v4-flash · 高峰]")) throw new Error("period tag missing");

// 1. initial position from config (no saved pos)
if (box.attributes.get("data-position") !== "top-right") throw new Error("config position not applied");

// 2. drag: down -> move -> up, expect inline left/top + saved localStorage
head.fire("pointerdown", { pointerId: 1, button: 0, clientX: 120, clientY: 90, preventDefault() {} });
head.fire("pointermove", { pointerId: 1, clientX: 260, clientY: 190 });
head.fire("pointerup", { pointerId: 1, clientX: 260, clientY: 190 });
const pos = JSON.parse(storage.get("dsh-token-usage-hud.pos"));
console.log("saved pos:", pos);
if (pos.left !== 240 || pos.top !== 180) throw new Error("saved position wrong: " + JSON.stringify(pos));
if (box.attributes.has("data-position")) throw new Error("data-position should be cleared after drag");
if (box.style.left !== "240px" || box.style.top !== "180px") throw new Error("inline position wrong");

// 3. clamp: drag far beyond bottom-right corner
head.fire("pointerdown", { pointerId: 2, button: 0, clientX: 100, clientY: 100, preventDefault() {} });
head.fire("pointermove", { pointerId: 2, clientX: 5000, clientY: 5000 });
head.fire("pointerup", { pointerId: 2, clientX: 5000, clientY: 5000 });
const clamped = JSON.parse(storage.get("dsh-token-usage-hud.pos"));
console.log("clamped pos:", clamped);
if (clamped.left !== 1280 - 220 || clamped.top !== 800 - 96) throw new Error("clamp failed: " + JSON.stringify(clamped));

// 4. hide -> pill appears near saved position
head.children.find((c) => c.dataset.tokenUsageHud === "close").fire("click", {});
const pill = documentStub.body.children.find((c) => c.dataset.tokenUsageHud === "pill");
if (!pill) throw new Error("pill not shown");
console.log("pill style:", JSON.stringify(pill.style));
if (pill.style.left !== "1060px") throw new Error("pill should use saved left");

// 5. pill click -> box restored at saved position
pill.fire("click", {});
const box2 = documentStub.body.children.find((c) => c.dataset.tokenUsageHud === "box");
if (!box2) throw new Error("box not restored");
if (box2.style.left !== "1060px" || box2.style.top !== "704px") throw new Error("restored position wrong");

// 6. dblclick resets to config position and clears saved pos
box2.children.find((c) => c.dataset.tokenUsageHud === "head").fire("dblclick", {});
console.log("after reset, saved:", storage.get("dsh-token-usage-hud.pos"));
if (storage.has("dsh-token-usage-hud.pos")) throw new Error("saved pos should be cleared on reset");
if (box2.attributes.get("data-position") !== "top-right") throw new Error("config position not restored");

// 7. unload cleans up DOM
disposer();
if (documentStub.body.children.some((c) => c.dataset.tokenUsageHud === "box" || c.dataset.tokenUsageHud === "pill")) throw new Error("DOM not cleaned on unload");

console.log("DRAG CHECK OK");
