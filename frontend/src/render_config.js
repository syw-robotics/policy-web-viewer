export const CAMERA_CONFIG = {
  fov: 45,
  near: 0.01,
  far: 100,
};

export const HOME_VIEW = {
  target: [0, 0.85, 0],
  position: [-3.0, 1.0, 3.2],
};

export const SCENE_CONFIG = {
  background: 0x15202a,
  fogNear: 9,
  fogFar: 18,
  maxPixelRatio: 2,
};

export const LIGHT_CONFIG = {
  hemisphereSky: 0xcfe7ff,
  hemisphereGround: 0x26322d,
  hemisphereIntensity: 1.1,
  keyColor: 0xffffff,
  keyIntensity: 2.2,
  keyOffset: [4.5, 7.5, 4.0],
  rimColor: 0xa8c8ff,
  rimIntensity: 0.65,
  rimPosition: [-4, 3, -5],
};

export const SHADOW_CONFIG = {
  mapSize: 2048,
  near: 0.2,
  far: 18,
  left: -7,
  right: 7,
  top: 7,
  bottom: -7,
};

export const FLOOR_CONFIG = {
  size: 120,
  canvasSize: 256,
  gridStep: 32,
  baseColor: '#26312e',
  lineColor: 'rgba(255,255,255,0.08)',
  repeat: [18, 18],
  roughness: 0.86,
};

export const GEOM_MATERIAL_CONFIG = {
  roughness: 0.52,
  metalness: 0.03,
  clearcoat: 0.15,
};

export const ORBIT_CONFIG = {
  initialRadius: 4.8,
  minRadius: 0.8,
  maxRadius: 14,
  rotateSpeed: 0.0045,
  panSpeed: 0.0012,
  minPhi: 0.18,
  maxPhiMargin: 0.18,
  zoomSpeed: 0.001,
};

export const FORCE_CONFIG = {
  dragGain: 30.0,
  dragMax: 80.0,
  arrowMaxLength: 1.25,
  dragDeadlineMs: 150.0,
};

export const CONTACT_CONFIG = {
  forceScale: 0.006,
  forceMaxLength: 0.8,
};

export const TORQUE_CONFIG = {
  dragDeadzonePx: 10.0,
  dragGain: 0.15,
  dragMax: 20.0,
};

export const RUNTIME_CONFIG = {
  defaultSimHz: 1000.0,
  showViewParams: false,
};

export function currentHomeViewFromControls(controls, digits = 3) {
  const target = controls.target;
  const position = controls.camera.position;
  return {
    target: [round(target.x, digits), round(target.y, digits), round(target.z, digits)],
    position: [round(position.x, digits), round(position.y, digits), round(position.z, digits)],
  };
}

export function formatHomeViewOverlay(controls) {
  const view = currentHomeViewFromControls(controls);
  return [
    'Copy to render_config.js:',
    'export const HOME_VIEW = {',
    `  target: [${view.target.join(', ')}],`,
    `  position: [${view.position.join(', ')}],`,
    '};',
    '',
    `radius: ${formatNumber(controls.radius)}`,
    `theta: ${formatNumber(controls.theta)} rad / ${formatNumber(radToDeg(controls.theta), 1)} deg`,
    `phi: ${formatNumber(controls.phi)} rad / ${formatNumber(radToDeg(controls.phi), 1)} deg`,
  ].join('\n');
}

function round(value, digits) {
  return Number(Number(value).toFixed(digits));
}

function formatNumber(value, digits = 3) {
  return Number(value).toFixed(digits);
}

function radToDeg(value) {
  return (value * 180) / Math.PI;
}
