/**
 * Minimal Chrome DevTools Protocol driver (no npm dependencies).
 *
 * Node 26 ships a global WebSocket, so this needs nothing installed. Used to
 * open the real Expo web preview in Chrome, drive it like a seller would, and
 * capture full-page screenshots for visual inspection.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = process.env.CDP_PROFILE ?? join(tmpdir(), 'sellflow-cdp-profile');
const SHOTS = process.env.CDP_SHOTS ?? join(tmpdir(), 'sellflow-shots');
const PORT = Number(process.env.CDP_PORT ?? 9222);

export function ensureDirs() {
  mkdirSync(SHOTS, { recursive: true });
}

export async function launch({ width = 390, height = 844, scale = 2 } = {}) {
  rmSync(PROFILE, { recursive: true, force: true });
  const child = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    `--window-size=${width},${height}`,
    `--force-device-scale-factor=${scale}`,
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--force-color-profile=srgb',
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  // Wait for the debugger endpoint.
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return { child, version: await res.json() };
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('Chrome debugging endpoint never came up');
}

export class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? {})})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  send(method, params = {}, sessionId) {
    this.id += 1;
    const id = this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 180000);
    });
  }

  on(fn) {
    this.listeners.push(fn);
  }

  /** Evaluates an expression in the page and returns the JSON value. */
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`page error: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception?.description ?? '')}`);
    }
    return res.result.value;
  }

  /** Captures a screenshot of the current viewport. */
  async screenshot(name) {
    mkdirSync(SHOTS, { recursive: true });
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    const path = `${SHOTS}\\${name}.png`;
    writeFileSync(path, Buffer.from(data, 'base64'));
    return path;
  }

  /** Captures the full scrollable page, so nothing below the fold is missed. */
  async fullPage(name) {
    mkdirSync(SHOTS, { recursive: true });
    const metrics = await this.send('Page.getLayoutMetrics');
    const h = Math.min(Math.ceil(metrics.cssContentSize.height), 8000);
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.ceil(metrics.cssContentSize.width), height: h, scale: 1 },
    });
    const path = `${SHOTS}\\${name}.png`;
    writeFileSync(path, Buffer.from(data, 'base64'));
    return path;
  }

  async goto(url, { waitMs = 3500 } = {}) {
    await this.send('Page.navigate', { url });
    await sleep(waitMs);
  }

  /** Pin an exact handset viewport so every capture is the same device. */
  async handset({ width = 390, height = 844, scale = 2 } = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: scale,
      mobile: true,
      screenWidth: width,
      screenHeight: height,
    });
  }

  /** The element RN is actually scrolling, if any. */
  scrollerInfo() {
    return this.evaluate(`(() => {
      const all = Array.from(document.querySelectorAll('div')).filter((d) => d.scrollHeight > d.clientHeight + 8);
      const main = all.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (!main) return { found: false };
      return { found: true, scrollHeight: main.scrollHeight, clientHeight: main.clientHeight, scrollTop: main.scrollTop };
    })()`);
  }

  async scrollBy(delta) {
    return this.evaluate(`(() => {
      const all = Array.from(document.querySelectorAll('div')).filter((d) => d.scrollHeight > d.clientHeight + 8);
      const main = all.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (!main) { window.scrollBy(0, ${delta}); return -1; }
      main.scrollTop = Math.max(0, main.scrollTop + ${delta});
      return main.scrollTop;
    })()`);
  }

  async scrollToTop() {
    await this.evaluate(`(() => {
      const all = Array.from(document.querySelectorAll('div')).filter((d) => d.scrollHeight > d.clientHeight + 8);
      const main = all.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (main) main.scrollTop = 0;
      window.scrollTo(0, 0);
    })()`);
    await sleep(400);
  }

  async click(selector, { waitMs = 900 } = {}) {
    const ok = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.click();
      return true;
    })()`);
    if (!ok) throw new Error(`click: no element for ${selector}`);
    await sleep(waitMs);
    return ok;
  }

  /** react-native-web renders a <div> per pressable; matches on aria/text. */
  async clickText(text, { waitMs = 900, exact = false } = {}) {
    const ok = await this.evaluate(`(() => {
      const want = ${JSON.stringify(text)};
      const nodes = Array.from(document.querySelectorAll('div,span,a,button,[role]'));
      const hit = nodes.filter((n) => {
        const t = (n.innerText || n.textContent || '').trim();
        if (n.querySelector('*') && t.length > 60) return false;
        return ${exact} ? t === want : t.includes(want);
      });
      const el = hit[hit.length - 1];
      if (!el) return false;
      const target = el.closest('[role],div') || el;
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      target.click();
      return true;
    })()`);
    if (!ok) throw new Error(`clickText: nothing matching "${text}"`);
    await sleep(waitMs);
    return ok;
  }

  async type(text, { delay = 25 } = {}) {
    await this.send('Input.insertText', { text });
    await sleep(delay);
  }

  async key(code, key, windowsVirtualKeyCode) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      code,
      key,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      code,
      key,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
    });
    await sleep(200);
  }

  async scroll(y) {
    await this.evaluate(`(() => {
      const scrollers = Array.from(document.querySelectorAll('div')).filter((d) => d.scrollHeight > d.clientHeight + 20);
      const main = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (main) main.scrollTop = ${y};
      else window.scrollTo(0, ${y});
      return main ? 'scroller' : 'window';
    })()`);
    await sleep(500);
  }

  /** Visible text of the page, useful for asserting content really rendered. */
  text() {
    return this.evaluate('document.body.innerText');
  }

  async close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  let target = list.find((t) => t.type === 'page');
  if (!target) {
    await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
    await sleep(700);
    target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const session = new Session(ws);
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Log.enable');
  await session.send('Network.enable');
  return session;
}

export { sleep, SHOTS, PORT };