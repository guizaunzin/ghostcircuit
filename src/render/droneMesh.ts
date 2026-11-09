// Procedural low-poly drone model (player and ghost variants).

import * as THREE from 'three';

export interface DroneModel {
  root: THREE.Group;
  /** Inner group that receives pitch/roll (root receives yaw/position). */
  body: THREE.Group;
  rotors: THREE.Object3D[];
  materials: THREE.Material[];
  setOpacity?(o: number): void;
  dispose(): void;
}

const ARM_SPAN = 0.76;
/** Visual scale; the collision radius stays the same. */
const MODEL_SCALE = 1.2;

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let sharedGlow: THREE.Texture | null = null;
export function getGlowTexture(): THREE.Texture {
  if (!sharedGlow) sharedGlow = glowTexture();
  return sharedGlow;
}

function buildGeometry(materials: {
  hull: THREE.Material;
  accent: THREE.Material;
  dark: THREE.Material;
  rotor: THREE.Material;
  front: THREE.Material;
  back: THREE.Material;
}): { body: THREE.Group; rotors: THREE.Object3D[] } {
  const body = new THREE.Group();
  // Fuselage: flattened octahedron-ish shape.
  const hullGeo = new THREE.CylinderGeometry(0.34, 0.46, 0.26, 6, 1);
  const hull = new THREE.Mesh(hullGeo, materials.hull);
  hull.rotation.y = Math.PI / 6;
  body.add(hull);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.26, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2), materials.accent);
  canopy.position.set(0, 0.1, 0.08);
  canopy.scale.set(1, 0.7, 1.3);
  body.add(canopy);
  // Nose light bar and tail light.
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.06, 0.06), materials.front);
  nose.position.set(0, 0.0, 0.44);
  body.add(nose);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.05), materials.back);
  tail.position.set(0, 0.02, -0.42);
  body.add(tail);

  const rotors: THREE.Object3D[] = [];
  const armGeo = new THREE.BoxGeometry(0.12, 0.08, ARM_SPAN * 1.25);
  const motorGeo = new THREE.CylinderGeometry(0.1, 0.12, 0.18, 6);
  const rotorGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.02, 10);
  const bladeGeo = new THREE.BoxGeometry(0.72, 0.015, 0.07);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const ax = Math.sin(a) * ARM_SPAN;
    const az = Math.cos(a) * ARM_SPAN;
    const arm = new THREE.Mesh(armGeo, materials.dark);
    arm.position.set(ax / 2, 0, az / 2);
    arm.rotation.y = a;
    body.add(arm);
    const motor = new THREE.Mesh(motorGeo, materials.dark);
    motor.position.set(ax, 0.04, az);
    body.add(motor);
    const rotor = new THREE.Group();
    rotor.position.set(ax, 0.15, az);
    const disc = new THREE.Mesh(rotorGeo, materials.rotor);
    rotor.add(disc);
    const blade = new THREE.Mesh(bladeGeo, materials.accent);
    rotor.add(blade);
    body.add(rotor);
    rotors.push(rotor);
  }
  return { body, rotors };
}

/** Player drone (orange) or an AI rival when `accentColor` is given. */
export function createPlayerDrone(accentColor = '#ff7a2f'): DroneModel {
  const accentC = new THREE.Color(accentColor);
  const hull = new THREE.MeshLambertMaterial({ color: 0xf2eee8, flatShading: true });
  const accent = new THREE.MeshLambertMaterial({
    color: accentC,
    emissive: accentC.clone().multiplyScalar(0.45),
    flatShading: true,
  });
  const dark = new THREE.MeshLambertMaterial({ color: 0x2b2838, flatShading: true });
  const rotor = new THREE.MeshBasicMaterial({ color: 0xffd2a8, transparent: true, opacity: 0.18, depthWrite: false });
  const front = new THREE.MeshBasicMaterial({ color: 0xbff8ff });
  const back = new THREE.MeshBasicMaterial({ color: 0xff3355 });
  const { body, rotors } = buildGeometry({ hull, accent, dark, rotor, front, back });
  const root = new THREE.Group();
  body.scale.setScalar(MODEL_SCALE);
  root.add(body);
  // Under-glow.
  const glowMat = new THREE.SpriteMaterial({
    map: getGlowTexture(),
    color: accentC,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const glow = new THREE.Sprite(glowMat);
  glow.scale.set(2.4, 2.4, 1);
  glow.position.y = -0.15;
  body.add(glow);
  const materials = [hull, accent, dark, rotor, front, back, glowMat];
  const solid = [hull, accent, dark, front, back];
  let faded = false;
  return {
    root,
    body,
    rotors,
    materials,
    /** Fades the drone (finished racers no longer interact). */
    setOpacity(o: number) {
      const want = o < 0.99;
      if (want !== faded) {
        faded = want;
        for (const m of solid) {
          m.transparent = want;
          m.depthWrite = !want;
          m.needsUpdate = true;
        }
      }
      for (const m of solid) m.opacity = o;
      glowMat.opacity = 0.55 * o;
    },
    dispose() {
      materials.forEach((m) => m.dispose());
    },
  };
}

export function createGhostDrone(): DroneModel {
  const color = 0x4ff3ff;
  const make = (o: number) =>
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: o, depthWrite: false, blending: THREE.AdditiveBlending });
  const hull = make(0.35);
  const accent = make(0.45);
  const dark = make(0.22);
  const rotor = make(0.1);
  const front = make(0.8);
  const back = make(0.6);
  const { body, rotors } = buildGeometry({ hull, accent, dark, rotor, front, back });
  const root = new THREE.Group();
  body.scale.setScalar(MODEL_SCALE);
  root.add(body);
  const glowMat = new THREE.SpriteMaterial({
    map: getGlowTexture(),
    color,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const glow = new THREE.Sprite(glowMat);
  glow.scale.set(3, 3, 1);
  body.add(glow);
  const materials: THREE.MeshBasicMaterial[] = [hull, accent, dark, rotor, front, back];
  const base = materials.map((m) => m.opacity);
  root.renderOrder = 5;
  return {
    root,
    body,
    rotors,
    materials: [...materials, glowMat],
    setOpacity(o: number) {
      materials.forEach((m, i) => (m.opacity = base[i] * o));
      glowMat.opacity = 0.5 * o;
    },
    dispose() {
      materials.forEach((m) => m.dispose());
      glowMat.dispose();
    },
  };
}
