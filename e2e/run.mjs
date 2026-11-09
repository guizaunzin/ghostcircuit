// End-to-end test of the critical player flow in a real browser.
//
//   npm run build && npm run test:e2e
//
// Starts `vite preview`, opens the game with `?test` (exposes the engine on
// window and lets an autopilot drive), and validates:
//   1. open + start, 2. full lap (4 checkpoints + finish), 3. retry against
//   the freshly recorded ghost, 4. new record updates the right recordings,
//   5. reload restores data, 6. abandoning keeps valid recordings, plus
//   pause on focus loss, mobile touch controls and console errors.
//
// Env: E2E_URL (skip starting a server), E2E_SPEED (sim speed, default 4),
//      E2E_HEADED=1, E2E_SCREENSHOTS=dir

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const SPEED = Number(process.env.E2E_SPEED || 4);
const SHOTS = process.env.E2E_SCREENSHOTS || 'e2e/output';
mkdirSync(SHOTS, { recursive: true });

let server = null;
let base = process.env.E2E_URL;
if (!base) {
  const port = 4199;
  base = `http://localhost:${port}`;
  server = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { stdio: 'pipe' });
  await waitForServer(base, 20000);
}

const errors = [];
let failures = 0;
let passes = 0;

function check(cond, msg) {
  if (cond) {
    passes++;
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
}

async function waitForServer(url, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('preview server did not start');
}

const launchArgs = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ headless: !process.env.E2E_HEADED, args: launchArgs });

function watch(page, label) {
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${label}] ${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
}

const state = (page) =>
  page.evaluate(() => {
    const e = window.__ghostCircuit;
    const s = e.state;
    const runs = e.getRuns();
    return {
      phase: s.phase,
      result: s.result,
      bestTime: s.bestTime,
      lastTime: s.lastTime,
      ghostChoice: s.ghostChoice,
      activeGhost: s.activeGhost,
      raceTime: e.sim.raceTime,
      next: e.sim.progress.next,
      splits: e.sim.progress.splits,
      ghostTime: e.sim.ghost ? e.sim.ghost.time : null,
      runsLast: runs.last ? runs.last.time : null,
      runsBest: runs.best ? runs.best.time : null,
      speed: Math.hypot(e.sim.drone.vx, e.sim.drone.vz),
      trackId: s.trackId,
      trackBests: s.trackBests,
    };
  });

const stored = (page, mapId = 'arena-crepusculo') =>
  page.evaluate((mapId) => {
    const raw = localStorage.getItem('ghostcircuit:runs:' + mapId);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return {
      last: d.last ? d.last.time : null,
      best: d.best === 'last' ? (d.last ? d.last.time : null) : d.best ? d.best.time : null,
      bestIsLast: d.best === 'last',
      prefs: JSON.parse(localStorage.getItem('ghostcircuit:prefs') || 'null'),
    };
  }, mapId);

async function waitPhase(page, phase, timeout = 120000) {
  await page.waitForFunction((p) => window.__ghostCircuit && window.__ghostCircuit.state.phase === p, phase, {
    timeout,
    polling: 200,
  });
}

async function race(page, autopilot) {
  await page.evaluate((o) => window.__ghostCircuit.setAutopilot(o), autopilot);
  await waitPhase(page, 'finished');
  await page.evaluate(() => window.__ghostCircuit.setAutopilot(null));
  return state(page);
}

try {
  // ------------------------------------------------------------------ desktop
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  watch(page, 'desktop');
  console.log('1. Abrir o jogo e iniciar');
  await page.goto(`${base}/?test&speed=${SPEED}`);
  await page.waitForFunction(() => !!window.__ghostCircuit, null, { timeout: 20000 });
  check(await page.getByRole('button', { name: 'Jogar' }).isVisible(), 'tela inicial com botão "Jogar"');
  check((await page.textContent('.map-best')).includes('—'), 'sem recorde na primeira visita');
  check((await state(page)).trackId === 'arena-crepusculo', 'pista padrão selecionada');
  await page.screenshot({ path: `${SHOTS}/01-menu.png` });
  await page.getByRole('button', { name: 'Jogar' }).click();
  let s = await state(page);
  check(s.phase === 'countdown', 'contagem regressiva começa');
  check(s.activeGhost === null, 'primeira corrida sem fantasma');
  check(await page.locator('.hud-hint').textContent().then((t) => t.includes('primeiro fantasma')), 'dica do primeiro fantasma');

  console.log('2. Completar os quatro checkpoints e a chegada');
  s = await race(page, { aggression: 0.35, useBoost: false, useShortcut: false });
  check(s.splits.length === 4 && s.splits.every((v, i) => i === 0 || v > s.splits[i - 1]), `4 checkpoints em ordem (${s.splits.map((v) => v.toFixed(2)).join(', ')})`);
  check(s.result && s.result.isNewBest && s.result.previousBest === null, `primeira volta concluída em ${s.result?.time.toFixed(2)}s`);
  const firstTime = s.result.time;
  let st = await stored(page);
  check(st && st.last === firstTime && st.best === firstTime, 'gravação salva no localStorage (última = recorde)');
  await page.screenshot({ path: `${SHOTS}/02-finish-first.png` });
  check(await page.getByRole('button', { name: 'Tentar novamente' }).isVisible(), 'botão "Tentar novamente" em destaque');

  console.log('3. Reiniciar e disputar com o fantasma recém-gravado');
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  s = await state(page);
  check(s.phase === 'countdown' && s.raceTime === 0 && s.next === 0, 'reinício restaura tempo e checkpoints');
  check(s.ghostTime === firstTime && s.activeGhost === 'last', 'fantasma = última corrida válida');
  await page.evaluate(() => window.__ghostCircuit.setAutopilot({ aggression: 0.9, useBoost: true, useShortcut: false }));
  await page.waitForFunction(() => window.__ghostCircuit.sim.progress.next >= 1, null, { timeout: 60000 });
  const ghostCheck = await page.evaluate(() => {
    const e = window.__ghostCircuit;
    const text = document.querySelector('.hud-ghost').textContent;
    return { text, ghostVisible: !!e.sim.ghost };
  });
  // Allow a frame for HUD update.
  await page.waitForTimeout(300);
  const hudGhost = await page.textContent('.hud-ghost');
  check(/vs fantasma [−+±]\d/.test(hudGhost), `delta no checkpoint exibido ("${hudGhost}")`);
  check(ghostCheck.ghostVisible, 'fantasma ativo durante a corrida');
  await page.screenshot({ path: `${SHOTS}/03-racing-ghost.png` });

  console.log('4. Bater o recorde e atualizar a gravação correta');
  await waitPhase(page, 'finished');
  await page.evaluate(() => window.__ghostCircuit.setAutopilot(null));
  s = await state(page);
  const secondTime = s.result.time;
  check(secondTime < firstTime, `segunda volta mais rápida (${secondTime.toFixed(2)} < ${firstTime.toFixed(2)})`);
  check(s.result.isNewBest && s.result.ghostDelta < 0, `novo recorde, delta vs fantasma ${s.result.ghostDelta.toFixed(2)}`);
  check(await page.locator('.record-title').isVisible(), 'celebração de novo recorde');
  st = await stored(page);
  check(st.best === secondTime && st.last === secondTime, 'recorde e última corrida atualizados');
  await page.screenshot({ path: `${SHOTS}/04-new-record.png` });

  // A slower run: only "last" changes.
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  s = await race(page, { aggression: 0.15, useBoost: false, useShortcut: false });
  const thirdTime = s.result.time;
  check(!s.result.isNewBest && thirdTime > secondTime, `volta mais lenta não substitui o recorde (${thirdTime.toFixed(2)})`);
  st = await stored(page);
  check(st.best === secondTime && st.last === thirdTime, 'última corrida = mais lenta, recorde preservado');
  // Pick "Meu recorde" for the next attempt.
  await page.getByRole('radio', { name: /Meu recorde/ }).click();
  st = await stored(page);
  check(st.prefs && st.prefs.ghost === 'best', 'preferência de fantasma salva');

  console.log('5. Recarregar a página e recuperar os dados');
  await page.reload();
  await page.waitForFunction(() => !!window.__ghostCircuit, null, { timeout: 20000 });
  s = await state(page);
  check(s.bestTime === secondTime && s.lastTime === thirdTime, 'recorde e última corrida recuperados');
  check(s.ghostChoice === 'best', 'escolha "Meu recorde" recuperada');
  check(/\d:\d\d\.\d\d/.test(await page.textContent('.map-best')), `recorde exibido no menu (${await page.textContent('.map-best')})`);
  await page.screenshot({ path: `${SHOTS}/05-menu-after-reload.png` });

  console.log('6. Abandonar uma tentativa sem perder gravações válidas');
  await page.getByRole('button', { name: 'Jogar' }).click();
  s = await state(page);
  check(s.ghostTime === secondTime && s.activeGhost === 'best', 'fantasma do recorde selecionado');
  await page.evaluate(() => window.__ghostCircuit.setAutopilot({ aggression: 0.6, useBoost: true, useShortcut: false }));
  await page.waitForFunction(() => window.__ghostCircuit.sim.progress.next >= 2, null, { timeout: 60000 });
  // Focus loss pauses the race and clears inputs.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  s = await state(page);
  check(s.phase === 'paused', 'perder o foco pausa a corrida');
  await page.screenshot({ path: `${SHOTS}/06-paused.png` });
  await page.keyboard.press('Escape');
  check((await state(page)).phase === 'racing', 'Esc retoma a corrida');
  await page.keyboard.press('KeyR');
  s = await state(page);
  check(s.phase === 'countdown' && s.next === 0 && s.raceTime === 0, 'R reinicia imediatamente');
  await page.evaluate(() => window.__ghostCircuit.setAutopilot(null));
  st = await stored(page);
  check(st.best === secondTime && st.last === thirdTime, 'tentativa abandonada não altera gravações');
  await page.reload();
  await page.waitForFunction(() => !!window.__ghostCircuit, null, { timeout: 20000 });
  s = await state(page);
  check(s.bestTime === secondTime && s.lastTime === thirdTime, 'gravações intactas após recarregar');

  console.log('7. Outras pistas (seeds) com recordes separados');
  await page.getByRole('button', { name: 'Próxima pista' }).click();
  s = await state(page);
  check(s.trackId !== 'arena-crepusculo' && s.bestTime === null && s.phase === 'menu', `troca de pista no menu (${s.trackId})`);
  const otherId = s.trackId;
  await page.screenshot({ path: `${SHOTS}/07-menu-other-map.png` });
  await page.getByRole('button', { name: 'Jogar' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/07b-other-map-countdown.png` });
  s = await race(page, { aggression: 0.8, useBoost: true, useShortcut: true });
  check(s.result && s.result.isNewBest && s.splits.length === 4, `volta completa em ${otherId} pelo atalho (${s.result?.time.toFixed(2)}s)`);
  const otherBest = s.result.time;
  st = await stored(page, otherId);
  check(st && st.best === otherBest, 'gravação salva na chave da outra pista');
  await page.screenshot({ path: `${SHOTS}/07c-other-map-finish.png` });
  await page.getByRole('button', { name: /Trocar pista/ }).click();
  await page.getByRole('button', { name: 'Pista anterior' }).click();
  s = await state(page);
  check(s.trackId === 'arena-crepusculo' && s.bestTime === secondTime, 'pista original mantém o próprio recorde');
  check(s.trackBests[otherId] === otherBest, 'recorde da outra pista exibido no seletor');
  await page.getByRole('button', { name: 'Próxima pista' }).click();
  await page.reload();
  await page.waitForFunction(() => !!window.__ghostCircuit, null, { timeout: 20000 });
  s = await state(page);
  check(s.trackId === otherId && s.bestTime === otherBest, 'pista escolhida e recorde lembrados após recarregar');

  console.log('8. Corrida contra drones de IA (dificuldade configurável)');
  await page.getByRole('radio', { name: /Corrida vs IA/ }).click();
  await page.getByRole('radio', { name: /^Fácil/ }).click();
  await page.getByRole('radio', { name: '1', exact: true }).click();
  s = await page.evaluate(() => {
    const e = window.__ghostCircuit;
    return { mode: e.state.mode, difficulty: e.state.difficulty, laps: e.state.laps, racers: e.sim.racers.length };
  });
  check(s.mode === 'race' && s.difficulty === 'facil' && s.laps === 1 && s.racers === 4, 'modo corrida: Fácil, 1 volta, 3 rivais no grid');
  await page.screenshot({ path: `${SHOTS}/08-race-menu.png` });
  await page.getByRole('button', { name: 'Jogar' }).click();
  await page.waitForTimeout(300);
  check((await page.textContent('.hud-position')).trim() === '4º/4', 'jogador larga em último (4º/4)');
  await page.screenshot({ path: `${SHOTS}/08b-race-grid.png` });
  s = await race(page, { aggression: 0.95, useBoost: true, useShortcut: true });
  check(s.result.mode === 'race' && s.result.position === 1, `vence os drones no Fácil (${s.result.time.toFixed(2)}s)`);
  check(await page.getByRole('heading', { name: 'Vitória!' }).isVisible(), 'tela de vitória com classificação');
  check((await page.locator('.standings li').count()) === 4, 'classificação com 4 drones');
  let raceStore = await page.evaluate((id) => JSON.parse(localStorage.getItem('ghostcircuit:race:' + id)), otherId);
  check(raceStore && raceStore.results['facil-1'].wins === 1, 'vitória salva por pista e dificuldade');
  await page.screenshot({ path: `${SHOTS}/08c-race-win.png` });
  // Harder rivals beat a weak pilot.
  await page.getByRole('radio', { name: /^Insano/ }).click();
  await page.getByRole('button', { name: /Correr de novo/ }).click();
  s = await state(page);
  check(s.phase === 'countdown', 'nova corrida no Insano direto da tela final');
  s = await race(page, { aggression: 0.1, useBoost: false, useShortcut: false });
  check(s.result.position > 1, `piloto fraco perde no Insano (${s.result.position}º)`);
  await page.screenshot({ path: `${SHOTS}/08d-race-lose.png` });
  raceStore = await page.evaluate((id) => JSON.parse(localStorage.getItem('ghostcircuit:race:' + id)), otherId);
  check(raceStore.results['insano-1'].wins === 0 && raceStore.results['facil-1'].wins === 1, 'resultados separados por dificuldade');
  await page.reload();
  await page.waitForFunction(() => !!window.__ghostCircuit, null, { timeout: 20000 });
  s = await page.evaluate(() => ({ ...window.__ghostCircuit.state }));
  check(s.mode === 'race' && s.difficulty === 'insano' && s.laps === 1, 'modo, dificuldade e voltas lembrados');
  check((await page.textContent('.map-best')).includes('Insano'), `cartão da pista mostra o resultado da configuração ("${await page.textContent('.map-best')}")`);
  // Abandon a race midway: nothing is saved.
  await page.getByRole('button', { name: 'Jogar' }).click();
  await page.evaluate(() => window.__ghostCircuit.setAutopilot({ aggression: 0.6, useBoost: true, useShortcut: false }));
  await page.waitForFunction(() => window.__ghostCircuit.sim.progress.next >= 1, null, { timeout: 60000 });
  await page.keyboard.press('KeyR');
  await page.evaluate(() => window.__ghostCircuit.setAutopilot(null));
  const afterAbandon = await page.evaluate((id) => JSON.parse(localStorage.getItem('ghostcircuit:race:' + id)), otherId);
  check(afterAbandon.results['insano-1'].races === 1, 'corrida abandonada não conta');
  // Ghost mode is still there and intact.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('radio', { name: /Contra o fantasma/ }).click();
  s = await state(page);
  check(s.bestTime === otherBest && (await page.getByRole('radio', { name: /Meu recorde/ }).isVisible()), 'modo fantasma mantém recorde e seletor de fantasma');

  // Corrupted storage must not break the game.
  await page.evaluate((id) => localStorage.setItem('ghostcircuit:runs:' + id, '{"format":1,"track":"x"'), otherId);
  await page.reload();
  await page.waitForFunction(() => !!window.__ghostCircuit, null, { timeout: 20000 });
  s = await state(page);
  check(s.phase === 'menu' && s.bestTime === null, 'dados corrompidos são ignorados sem travar o jogo');
  await ctx.close();

  // ------------------------------------------------------------------- mobile
  console.log('9. Celular (viewport touch, modo corrida)');
  const mctx = await browser.newContext({ ...devices['Pixel 7'] });
  const m = await mctx.newPage();
  watch(m, 'mobile');
  await m.goto(`${base}/?test&speed=1`);
  await m.waitForFunction(() => !!window.__ghostCircuit, null, { timeout: 20000 });
  await m.screenshot({ path: `${SHOTS}/07-mobile-menu-portrait.png` });
  await m.setViewportSize({ width: 915, height: 412 });
  await m.getByRole('radio', { name: /Corrida vs IA/ }).tap();
  await m.screenshot({ path: `${SHOTS}/07a-mobile-race-menu-landscape.png` });
  await m.getByRole('button', { name: 'Jogar' }).tap();
  await waitPhase(m, 'racing', 20000);
  check(await m.locator('.touch-btn.t-throttle').isVisible(), 'botões touch visíveis');
  const box = await m.locator('.t-throttle').boundingBox();
  const zone = await m.locator('.touch-stick-zone').boundingBox();
  const cdp = await mctx.newCDPSession(m);
  // Two simultaneous touches: throttle (right) + steering stick (left).
  const tx = box.x + box.width / 2;
  const ty = box.y + box.height / 2;
  const sx = zone.x + 120;
  const sy = zone.y + zone.height - 100;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: tx, y: ty, id: 1 },
      { x: sx, y: sy, id: 2 },
    ],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { x: tx, y: ty, id: 1 },
      { x: sx + 14, y: sy, id: 2 },
    ],
  });
  await m.waitForTimeout(1500);
  const touchState = await m.evaluate(() => ({ ...window.__ghostCircuit.input.touch }));
  s = await state(m);
  check(touchState.throttle && touchState.steer > 0.05, `toques simultâneos: acelerar + direção (steer ${touchState.steer.toFixed(2)})`);
  check(s.speed > 5, `drone acelera pelo toque (${(s.speed * 3.6).toFixed(0)} km/h)`);
  await m.screenshot({ path: `${SHOTS}/08-mobile-racing.png` });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await m.waitForTimeout(200);
  const released = await m.evaluate(() => ({ ...window.__ghostCircuit.input.touch }));
  check(!released.throttle && released.steer === 0, 'soltar os dedos libera os controles');
  const scroll = await m.evaluate(() => ({ x: window.scrollX, y: window.scrollY, h: document.documentElement.scrollHeight, vh: innerHeight }));
  check(scroll.x === 0 && scroll.y === 0, 'página não rola durante a pilotagem');
  await mctx.close();
} catch (e) {
  failures++;
  console.error('E2E error:', e);
} finally {
  await browser.close();
  if (server) server.kill();
}

const relevant = errors.filter((e) => !/GPU stall|swiftshader|WebGL.*performance|Automatic fallback to software/i.test(e));
console.log(`\nConsole errors/warnings: ${relevant.length}`);
relevant.forEach((e) => console.log('  ' + e));
if (relevant.length) failures++;
console.log(`\n${passes} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
