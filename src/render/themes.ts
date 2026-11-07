// Visual themes (one per map). Colors are CSS hex strings.

import type { ThemeId } from '../game/track';

export interface Theme {
  label: string;
  skyTop: string;
  skyMid: string;
  horizon: string;
  sun: string;
  /** Sun/moon glow strength in the sky shader. */
  sunGlow: number;
  /** Sun height above the horizon (0..1, direction y). */
  sunElevation: number;
  /** Sun azimuth relative to the start direction (radians, 0 = straight ahead). */
  sunAzimuth: number;
  fog: string;
  fogNear: number;
  fogFar: number;
  ground: string;
  grid: string;
  mountain: string;
  tower: string;
  towerCaps: [string, string, string];
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  sunLight: string;
  sunIntensity: number;
  ambient: string;
  ambientIntensity: number;
  surface: string;
  /** Main walls and lane edges. */
  wall: string;
  /** Shortcut walls (signals risk). */
  shortcut: string;
  gateNext: string;
  gateUpcoming: string;
  gatePassed: string;
  hazard: string;
  obstacle: string;
  /** CSS accent for menus (map card). */
  ui: string;
}

export const THEMES: Record<ThemeId, Theme> = {
  crepusculo: {
    label: 'Entardecer',
    skyTop: '#120a2a',
    skyMid: '#4b1d5c',
    horizon: '#ff7a59',
    sun: '#ffc36b',
    sunGlow: 0.55,
    sunElevation: 0.1,
    sunAzimuth: 0.3,
    fog: '#3b1b45',
    fogNear: 160,
    fogFar: 900,
    ground: '#130d22',
    grid: '#ff4fa3',
    mountain: '#2a1538',
    tower: '#241c3a',
    towerCaps: ['#38e8ff', '#ff3ea5', '#ffb347'],
    hemiSky: '#8a6bd1',
    hemiGround: '#ff7a4a',
    hemiIntensity: 1.35,
    sunLight: '#ffb27a',
    sunIntensity: 2.2,
    ambient: '#2a1f4a',
    ambientIntensity: 0.6,
    surface: '#2a2342',
    wall: '#38e8ff',
    shortcut: '#ffb347',
    gateNext: '#ff3ea5',
    gateUpcoming: '#7f8cff',
    gatePassed: '#3a3450',
    hazard: '#ff5a36',
    obstacle: '#2a2140',
    ui: '#ff7a59',
  },
  noturno: {
    label: 'Noite',
    skyTop: '#02020a',
    skyMid: '#0a0d33',
    horizon: '#3b1f7a',
    sun: '#dfe6ff',
    sunGlow: 0.35,
    sunElevation: 0.32,
    sunAzimuth: -0.5,
    fog: '#07081f',
    fogNear: 120,
    fogFar: 760,
    ground: '#04050d',
    grid: '#3d6bff',
    mountain: '#0d0f2a',
    tower: '#0b0c22',
    towerCaps: ['#3d6bff', '#ff3ea5', '#b26bff'],
    hemiSky: '#3a4aa8',
    hemiGround: '#2a0f4a',
    hemiIntensity: 1.1,
    sunLight: '#9fb2ff',
    sunIntensity: 1.1,
    ambient: '#1a1f4a',
    ambientIntensity: 0.8,
    surface: '#161838',
    wall: '#ff3ea5',
    shortcut: '#ffb347',
    gateNext: '#ffe14d',
    gateUpcoming: '#6f7dff',
    gatePassed: '#24264a',
    hazard: '#ff7a2f',
    obstacle: '#15163a',
    ui: '#3d6bff',
  },
  aurora: {
    label: 'Amanhecer',
    skyTop: '#10204a',
    skyMid: '#3d6fa8',
    horizon: '#ffb3c7',
    sun: '#fff3d6',
    sunGlow: 0.5,
    sunElevation: 0.07,
    sunAzimuth: 0.6,
    fog: '#4a5d8f',
    fogNear: 170,
    fogFar: 950,
    ground: '#0f1830',
    grid: '#7ff6ff',
    mountain: '#2a3d66',
    tower: '#1b2747',
    towerCaps: ['#7ff6ff', '#ffb3c7', '#ffffff'],
    hemiSky: '#b8d4ff',
    hemiGround: '#ffb3c7',
    hemiIntensity: 1.4,
    sunLight: '#ffe2c4',
    sunIntensity: 2,
    ambient: '#2a3a66',
    ambientIntensity: 0.6,
    surface: '#1c2a48',
    wall: '#7dffb2',
    shortcut: '#ffb347',
    gateNext: '#ff4fa3',
    gateUpcoming: '#8fb7ff',
    gatePassed: '#2c3a5c',
    hazard: '#ff5a6e',
    obstacle: '#1d2a4a',
    ui: '#7dffb2',
  },
  duna: {
    label: 'Deserto',
    skyTop: '#1f3f7a',
    skyMid: '#c9734a',
    horizon: '#ffd18a',
    sun: '#fff0bd',
    sunGlow: 0.7,
    sunElevation: 0.18,
    sunAzimuth: -0.25,
    fog: '#b0643f',
    fogNear: 180,
    fogFar: 950,
    ground: '#2a160e',
    grid: '#ff9a3d',
    mountain: '#6b3320',
    tower: '#3a2016',
    towerCaps: ['#ffcf5a', '#ff4f6d', '#38e8ff'],
    hemiSky: '#ffd6a0',
    hemiGround: '#a0502a',
    hemiIntensity: 1.4,
    sunLight: '#ffd9a0',
    sunIntensity: 2.4,
    ambient: '#4a2a1a',
    ambientIntensity: 0.5,
    surface: '#3a2418',
    wall: '#ff4f6d',
    shortcut: '#ffe066',
    gateNext: '#38e8ff',
    gateUpcoming: '#ffcf8a',
    gatePassed: '#4a2e22',
    hazard: '#ff3b2f',
    obstacle: '#3a1e14',
    ui: '#ffcf5a',
  },
  tempestade: {
    label: 'Tempestade',
    skyTop: '#0b1418',
    skyMid: '#1f3a3f',
    horizon: '#6fbf9a',
    sun: '#d6fff0',
    sunGlow: 0.3,
    sunElevation: 0.25,
    sunAzimuth: 0.9,
    fog: '#172a2c',
    fogNear: 110,
    fogFar: 720,
    ground: '#08110f',
    grid: '#2fffb0',
    mountain: '#12221f',
    tower: '#0f1c1b',
    towerCaps: ['#2fffb0', '#ffe14d', '#ff3ea5'],
    hemiSky: '#6fbfa0',
    hemiGround: '#1a2a40',
    hemiIntensity: 1.2,
    sunLight: '#c8ffe8',
    sunIntensity: 1.3,
    ambient: '#10201f',
    ambientIntensity: 0.8,
    surface: '#142422',
    wall: '#ffe14d',
    shortcut: '#ff8a3d',
    gateNext: '#ff3ea5',
    gateUpcoming: '#6fd6c0',
    gatePassed: '#1f3330',
    hazard: '#ff5a36',
    obstacle: '#132220',
    ui: '#2fffb0',
  },
};

export function getTheme(id: ThemeId): Theme {
  return THEMES[id] ?? THEMES.crepusculo;
}
