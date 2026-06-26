const GEOM = {
  PLANE: 0,
  SPHERE: 2,
  CAPSULE: 3,
  ELLIPSOID: 4,
  CYLINDER: 5,
  BOX: 6,
  MESH: 7,
};

window.addEventListener("error", (event) => {
  const loading = document.querySelector("#loading");
  if (loading) {
    loading.hidden = false;
    loading.textContent = `Viewer error: ${event.message}`;
  }
});

window.addEventListener("unhandledrejection", (event) => {
  const loading = document.querySelector("#loading");
  if (loading) {
    loading.hidden = false;
    loading.textContent = `Viewer error: ${event.reason?.message || event.reason}`;
  }
});

const state = {
  running: true,
  command: [],
  commandSchema: null,
  commandSchemaSignature: "",
  commandControls: [],
  commandHotkeys: new Set(),
  keyboardCommandActive: false,
  keys: new Set(),
  follow: true,
  showContacts: false,
  dragEnabled: true,
  renderScale: Math.min(window.devicePixelRatio || 1, 2),
  sceneLoaded: false,
  followBodyId: null,
  draggingForce: false,
  draggingCommandSlider: false,
  commandEditUntil: 0,
};

// External force and torque drag parameters
const FORCE_DRAG_GAIN = 30.0;
const FORCE_DRAG_MAX = 80.0;
const FORCE_DRAG_MAX_OFFSET = FORCE_DRAG_MAX / FORCE_DRAG_GAIN;
const FORCE_ARROW_MAX_LENGTH = 1.25;
const CONTACT_FORCE_SCALE = 0.006;
const CONTACT_FORCE_MAX_LENGTH = 0.8;
const TORQUE_DRAG_DEADZONE_PX = 10.0;
const TORQUE_DRAG_GAIN = 0.15;
const TORQUE_DRAG_MAX = 20.0;

// show view params overlay for debugging
const SHOW_VIEW_PARAMS = false;
const HOME_VIEW = {
  target: [0, 0.85, 0],
  position: [3.0, 2.0, 3.2],
};

const el = {
  viewport: document.querySelector("#viewport"),
  loading: document.querySelector("#loading"),
  run: document.querySelector("#run"),
  reset: document.querySelector("#reset"),
  switchPolicy: document.querySelector("#switch-policy"),
  follow: document.querySelector("#follow"),
  contacts: document.querySelector("#contacts"),
  viewHome: document.querySelector("#view-home"),
  drag: document.querySelector("#drag"),
  policy: document.querySelector("#policy"),
  time: document.querySelector("#time"),
  height: document.querySelector("#height"),
  performance: document.querySelector("#performance"),
  connection: document.querySelector("#connection"),
  subtitle: document.querySelector("#subtitle"),
  commandControls: document.querySelector("#command-controls"),
  commandHelp: document.querySelector("#command-help"),
  viewParams: null,
};

const three = {
  scene: new THREE.Scene(),
  camera: new THREE.PerspectiveCamera(45, 1, 0.01, 100),
  renderer: new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" }),
  controls: null,
  dragger: null,
  keyLight: null,
  keyLightTarget: null,
  bodies: new Map(),
  draggableMeshes: [],
  meshCache: new Map(),
  contactGroup: new THREE.Group(),
  contactVisuals: [],
  followTarget: new THREE.Vector3(0, 0.85, 0),
};

function initRenderer() {
  three.scene.background = new THREE.Color(0x15202a);
  three.scene.fog = new THREE.Fog(0x15202a, 9, 18);

  three.renderer.shadowMap.enabled = true;
  three.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  three.renderer.outputColorSpace = THREE.SRGBColorSpace;
  three.renderer.outputEncoding = THREE.sRGBEncoding;
  el.viewport.appendChild(three.renderer.domElement);
  initViewParamsOverlay();

  three.controls = new SimpleOrbitControls(three.camera, three.renderer.domElement);
  resetView();
  three.dragger = new DragForceManager(three.scene, three.camera, three.renderer.domElement, three.controls);
  three.contactGroup.visible = false;
  three.scene.add(three.contactGroup);

  three.scene.add(new THREE.HemisphereLight(0xcfe7ff, 0x26322d, 1.1));

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(4, 6, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.2;
  key.shadow.camera.far = 18;
  key.shadow.camera.left = -7;
  key.shadow.camera.right = 7;
  key.shadow.camera.top = 7;
  key.shadow.camera.bottom = -7;
  key.target.position.set(0, 0, 0);
  three.scene.add(key);
  three.scene.add(key.target);
  three.keyLight = key;
  three.keyLightTarget = key.target;

  const rim = new THREE.DirectionalLight(0xa8c8ff, 0.65);
  rim.position.set(-4, 3, -5);
  three.scene.add(rim);

  window.addEventListener("resize", resize);
  resize();
  three.renderer.setAnimationLoop(render);
}

async function loadScene() {
  const scene = await fetchJson("/api/scene");
  el.subtitle.textContent = `${scene.robot} / ${scene.terrain}`;
  if (scene.command_schema) {
    applyCommandSchema(scene.command_schema);
  }

  for (const body of scene.bodies) {
    const group = new THREE.Group();
    group.name = body.name;
    group.userData.bodyId = body.id;
    three.bodies.set(body.id, group);
    three.scene.add(group);
    if (body.name === "pelvis" || body.name === "base") {
      state.followBodyId = body.id;
    }
  }
  if (state.followBodyId === null && scene.bodies.length > 1) {
    state.followBodyId = scene.bodies[1].id;
  }

  for (const geom of scene.geoms) {
    const body = three.bodies.get(geom.body_id);
    if (!body) {
      continue;
    }
    const mesh = buildGeom(geom, scene.meshes);
    if (!mesh) {
      continue;
    }
    mesh.position.copy(mjPos(geom.pos));
    if (geom.type !== GEOM.PLANE) {
      mesh.quaternion.copy(mjQuat(geom.quat));
    }
    mesh.castShadow = geom.type !== GEOM.PLANE;
    mesh.receiveShadow = true;
    if (geom.type !== GEOM.PLANE) {
      mesh.userData.bodyId = geom.body_id;
      three.draggableMeshes.push(mesh);
    }
    body.add(mesh);
  }

  state.sceneLoaded = true;
  el.loading.hidden = true;
}

function buildGeom(geom, meshes) {
  const size = geom.size;
  let geometry;

  if (geom.type === GEOM.PLANE) {
    geometry = new THREE.PlaneGeometry(120, 120);
    const mesh = new THREE.Mesh(geometry, floorMaterial());
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    return mesh;
  }
  if (geom.type === GEOM.SPHERE) {
    geometry = new THREE.SphereGeometry(size[0], 32, 16);
  } else if (geom.type === GEOM.CAPSULE) {
    geometry = new THREE.CapsuleGeometry(size[0], size[1] * 2, 16, 24);
  } else if (geom.type === GEOM.ELLIPSOID) {
    geometry = new THREE.SphereGeometry(1, 32, 16);
  } else if (geom.type === GEOM.CYLINDER) {
    geometry = new THREE.CylinderGeometry(size[0], size[0], size[1] * 2, 32);
  } else if (geom.type === GEOM.BOX) {
    geometry = new THREE.BoxGeometry(size[0] * 2, size[2] * 2, size[1] * 2);
  } else if (geom.type === GEOM.MESH) {
    geometry = meshGeometry(geom.mesh_id, meshes[String(geom.mesh_id)]);
  } else {
    return null;
  }

  const mesh = new THREE.Mesh(geometry, materialFor(geom.rgba));
  if (geom.type === GEOM.ELLIPSOID) {
    mesh.scale.set(size[0], size[2], size[1]);
  }
  return mesh;
}

function meshGeometry(meshId, meshData) {
  if (three.meshCache.has(meshId)) {
    return three.meshCache.get(meshId);
  }
  if (!meshData) {
    return new THREE.BoxGeometry(0.02, 0.02, 0.02);
  }

  const positions = [];
  const normals = [];
  const vertices = meshData.vertices;
  const sourceNormals = meshData.normals;
  for (let i = 0; i < vertices.length; i += 3) {
    positions.push(vertices[i], vertices[i + 2], -vertices[i + 1]);
  }
  for (let i = 0; i < sourceNormals.length; i += 3) {
    normals.push(sourceNormals[i], sourceNormals[i + 2], -sourceNormals[i + 1]);
  }

  const indices = [];
  const faces = meshData.faces;
  for (let i = 0; i < faces.length; i += 3) {
    indices.push(faces[i], faces[i + 1], faces[i + 2]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  three.meshCache.set(meshId, geometry);
  return geometry;
}

function materialFor(rgba) {
  const color = new THREE.Color(rgba[0], rgba[1], rgba[2]);
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.52,
    metalness: 0.03,
    clearcoat: 0.15,
    transparent: rgba[3] < 1,
    opacity: rgba[3],
  });
}

function floorMaterial() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#26312e";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 2;
  for (let i = 0; i <= 256; i += 32) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 256);
    ctx.moveTo(0, i);
    ctx.lineTo(256, i);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(18, 18);
  return new THREE.MeshStandardMaterial({ color: 0xffffff, map: texture, roughness: 0.86 });
}

function buildContactViz() {
  const group = new THREE.Group();
  const point = new THREE.Mesh(
    new THREE.SphereGeometry(0.025, 16, 8),
    new THREE.MeshBasicMaterial({ color: 0x55d6ff, depthTest: true }),
  );
  const arrow = buildContactForceVectorViz();
  group.add(point, arrow);
  group.userData.point = point;
  group.userData.arrow = arrow;
  return group;
}

function buildContactForceVectorViz() {
  const group = new THREE.Group();
  const material = new THREE.MeshPhysicalMaterial({
    color: 0x55d6ff,
    emissive: 0x08384a,
    emissiveIntensity: 0.45,
    roughness: 0.35,
    metalness: 0.02,
  });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.014, 1, 16), material);
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.045, 1, 20), material);
  group.add(shaft, head);
  group.userData.shaft = shaft;
  group.userData.head = head;
  return group;
}

async function frameLoop() {
  while (true) {
    try {
      const frame = await fetchJson(state.showContacts ? "/api/frame?contacts=1" : "/api/frame");
      updateBodies(frame.bodies);
      updateContacts(frame.contacts || []);
      renderStatus(frame.status, { acceptCommand: performance.now() >= state.commandEditUntil });
      setConnection(true);
    } catch {
      setConnection(false);
    }
    await sleep(33);
  }
}

function updateContacts(contacts) {
  three.contactGroup.visible = state.showContacts;
  if (!state.showContacts) {
    hideUnusedContacts(0);
    return;
  }

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    const viz = contactVizAt(i);
    const pos = mjPos(contact.pos);
    viz.visible = true;
    viz.position.copy(pos);
    viz.userData.point.position.set(0, 0, 0);

    const forceVector = contactForceVector(contact.force);
    setForceVectorViz(viz.userData.arrow, new THREE.Vector3(), forceVector);
  }
  hideUnusedContacts(contacts.length);
}

function contactVizAt(index) {
  while (three.contactVisuals.length <= index) {
    const viz = buildContactViz();
    three.contactVisuals.push(viz);
    three.contactGroup.add(viz);
  }
  return three.contactVisuals[index];
}

function hideUnusedContacts(start) {
  for (let i = start; i < three.contactVisuals.length; i++) {
    three.contactVisuals[i].visible = false;
  }
}

function contactForceVector(force) {
  const vector = mjPos(force);
  const forceNorm = vector.length();
  if (forceNorm <= 1e-6) {
    return new THREE.Vector3();
  }
  return vector.setLength(Math.min(forceNorm * CONTACT_FORCE_SCALE, CONTACT_FORCE_MAX_LENGTH));
}

function updateBodies(bodies) {
  for (const body of bodies) {
    const group = three.bodies.get(body.id);
    if (!group) {
      continue;
    }
    group.position.copy(mjPos(body.pos));
    group.quaternion.copy(mjQuat(body.quat));
  }
}

function updateFollow() {
  if (state.followBodyId === null) {
    return;
  }
  const body = three.bodies.get(state.followBodyId);
  if (!body) {
    return;
  }
  const desired = new THREE.Vector3(body.position.x, 0.85, body.position.z);
  updateShadowFollow(desired);
  if (state.follow) {
    three.followTarget.lerp(desired, 0.08);
    const delta = desired.clone().sub(three.controls.target);
    three.controls.target.add(delta);
  }
}

function updateShadowFollow(target) {
  if (!three.keyLight || !three.keyLightTarget) {
    return;
  }
  three.keyLightTarget.position.copy(target);
  three.keyLight.position.copy(target).add(new THREE.Vector3(4.5, 7.5, 4.0));
  three.keyLightTarget.updateMatrixWorld();
  three.keyLight.updateMatrixWorld();
}

function render() {
  updateFollow();
  three.controls.update();
  three.dragger?.update();
  updateViewParamsOverlay();
  three.renderer.render(three.scene, three.camera);
}

function resize() {
  const { clientWidth, clientHeight } = el.viewport;
  three.camera.aspect = clientWidth / Math.max(clientHeight, 1);
  three.camera.updateProjectionMatrix();
  three.renderer.setPixelRatio(state.renderScale);
  three.renderer.setSize(clientWidth, clientHeight, false);
}

function resetView() {
  const target = new THREE.Vector3(...HOME_VIEW.target);
  const position = new THREE.Vector3(...HOME_VIEW.position);
  const offset = position.sub(target);
  const radius = Math.max(offset.length(), 0.001);

  three.controls.target.copy(target);
  three.controls.radius = radius;
  three.controls.theta = Math.atan2(offset.x, offset.z);
  three.controls.phi = Math.acos(Math.max(-1, Math.min(1, offset.y / radius)));
  three.controls.update();
}

function initViewParamsOverlay() {
  if (!SHOW_VIEW_PARAMS) {
    return;
  }
  el.viewParams = document.createElement("pre");
  el.viewParams.className = "view-params";
  el.viewport.appendChild(el.viewParams);
}

function updateViewParamsOverlay() {
  if (!el.viewParams || !three.controls) {
    return;
  }
  const target = three.controls.target;
  el.viewParams.textContent = [
    "Home view params",
    `target.set(${fmt(target.x)}, ${fmt(target.y)}, ${fmt(target.z)});`,
    `radius = ${fmt(three.controls.radius)};`,
    `theta = ${fmt(three.controls.theta)}; // ${fmt(radToDeg(three.controls.theta), 1)} deg`,
    `phi = ${fmt(three.controls.phi)}; // ${fmt(radToDeg(three.controls.phi), 1)} deg`,
  ].join("\n");
}

const fmt = (value, digits = 3) => Number(value).toFixed(digits);
const radToDeg = (value) => (value * 180) / Math.PI;

const activeCommand = () => {
  if (state.keyboardCommandActive) {
    return keyCommand();
  }
  return commandFromControls();
};

function keyCommand() {
  const schema = state.commandSchema;
  if (!schema) {
    return [];
  }
  const command = defaultCommand(schema);
  for (let i = 0; i < schema.dims.length; i++) {
    const dim = schema.dims[i];
    const hotkeys = dim.hotkeys || {};
    const positive = hotkeys.positive && state.keys.has(hotkeys.positive);
    const negative = hotkeys.negative && state.keys.has(hotkeys.negative);
    if (!positive && !negative) {
      continue;
    }
    if (positive && !negative) {
      command[i] = Number(dim.max);
    } else if (negative && !positive) {
      command[i] = Number(dim.min);
    }
  }
  return command;
}

function commandFromControls() {
  return state.commandControls.map((control) => commandControlValue(control));
}

function commandControlValue(control) {
  if (control.type === "toggle") {
    return control.input.checked ? Number(control.dim.max) : Number(control.dim.min);
  }
  return Number(control.input.value);
}

function defaultCommand(schema) {
  return schema.dims.map((dim) => Number(dim.default || 0));
}

async function post(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

function setConnection(ok) {
  el.connection.textContent = ok ? "Connected" : "Disconnected";
  el.connection.dataset.state = ok ? "ok" : "error";
}

function renderStatus(payload, options = {}) {
  if (payload.command_schema) {
    applyCommandSchema(payload.command_schema);
  }
  state.running = Boolean(payload.running);
  const acceptCommand = options.acceptCommand ?? true;
  if (payload.command && acceptCommand) {
    state.command = payload.command;
  }
  updateCommandDisplay(state.command);
  if (!state.draggingCommandSlider && !state.keyboardCommandActive) {
    updateCommandInputs(state.command);
  }
  el.run.textContent = state.running ? "Pause" : "Start";
  el.policy.textContent = payload.policy || "-";
  el.time.textContent = `${Number(payload.time || 0).toFixed(3)} s`;
  el.height.textContent = `${Number(payload.height || 0).toFixed(3)} m`;
  el.performance.textContent = `${Number(payload.rtf || 0).toFixed(2)} RTF`;
  if (payload.robot) {
    el.subtitle.textContent = `${payload.robot} / ${payload.terrain}`;
  }
  el.switchPolicy.disabled = !payload.switch_enabled;
}

const signed = (value) => `${value >= 0 ? "+" : ""}${Number(value).toFixed(2)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendCommand(command = activeCommand(), force = false) {
  if (!command.length) {
    return;
  }
  if (
    !force &&
    command.length === state.command.length &&
    command.every((value, index) => value === state.command[index])
  ) {
    return;
  }
  try {
    renderStatus(await post("/api/command", { command }));
    setConnection(true);
  } catch {
    setConnection(false);
  }
}

async function resetSimulation() {
  try {
    renderStatus(await post("/api/control", { action: "reset" }));
    setConnection(true);
  } catch {
    setConnection(false);
  }
}

async function toggleSimulation() {
  try {
    renderStatus(await post("/api/control", { action: state.running ? "pause" : "start" }));
    setConnection(true);
  } catch {
    setConnection(false);
  }
}

function updateCommandDisplay(command) {
  for (const control of state.commandControls) {
    const value = command[control.index] ?? control.dim.default ?? 0;
    control.value.textContent = formatCommandValue(control.dim, value);
  }
}

function updateCommandInputs(command) {
  for (const control of state.commandControls) {
    const value = command[control.index] ?? control.dim.default ?? 0;
    if (control.type === "toggle") {
      control.input.checked = Number(value) === Number(control.dim.max);
    } else {
      control.input.value = String(value);
    }
  }
}

function handleCommandInput() {
  const command = commandFromControls();
  state.draggingCommandSlider = true;
  state.commandEditUntil = performance.now() + 250;
  state.command = command;
  updateCommandDisplay(command);
  sendCommand(command, true);
}

function finishSliderDrag() {
  state.draggingCommandSlider = false;
  updateCommandInputs(state.command);
  updateCommandDisplay(state.command);
}

function sendKeyboardCommand() {
  const command = keyCommand();
  state.command = command;
  updateCommandInputs(command);
  updateCommandDisplay(command);
  sendCommand(command, true);
}

function applyCommandSchema(schema) {
  const signature = JSON.stringify(schema);
  if (signature === state.commandSchemaSignature) {
    return;
  }
  state.commandSchema = schema;
  state.commandSchemaSignature = signature;
  state.command = defaultCommand(schema);
  state.keys.clear();
  state.keyboardCommandActive = false;
  buildCommandControls(schema);
  updateCommandInputs(state.command);
  updateCommandDisplay(state.command);
  updateCommandHelp(schema);
}

function updateCommandHelp(schema) {
  if (!el.commandHelp) {
    return;
  }
  const pairs = [];
  for (const dim of schema?.dims || []) {
    const hotkeys = dim.hotkeys || {};
    if (hotkeys.positive || hotkeys.negative) {
      pairs.push(`${formatKey(hotkeys.positive)}/${formatKey(hotkeys.negative)} ${dim.label}`);
    }
  }
  el.commandHelp.innerHTML = `<b>Command:</b> ${pairs.length ? pairs.join(" · ") : "use the panel controls"}`;
}

function formatKey(code) {
  if (!code) {
    return "-";
  }
  if (code.startsWith("Key")) {
    return code.slice(3);
  }
  if (code.startsWith("Digit")) {
    return code.slice(5);
  }
  return code.replace(/^Arrow/, "");
}

function buildCommandControls(schema) {
  el.commandControls.replaceChildren();
  state.commandControls = [];
  state.commandHotkeys = new Set();

  const title = document.createElement("div");
  title.className = "command-title";
  title.textContent = schema.title || "Command";
  el.commandControls.append(title);

  for (let i = 0; i < schema.dims.length; i++) {
    const dim = schema.dims[i];
    const row = document.createElement("label");
    row.className = `command-row command-row-${dim.type}`;

    const header = document.createElement("span");
    const label = document.createElement("span");
    label.textContent = dim.unit ? `${dim.label} (${dim.unit})` : dim.label;
    const value = document.createElement("strong");
    header.append(label, value);
    row.append(header);

    const input = buildCommandInput(dim);
    row.append(input);
    el.commandControls.append(row);

    state.commandControls.push({
      index: i,
      dim,
      input,
      value,
      type: dim.type,
    });

    for (const code of Object.values(dim.hotkeys || {})) {
      state.commandHotkeys.add(code);
    }
  }
}

function buildCommandInput(dim) {
  if (dim.type === "select") {
    const select = document.createElement("select");
    for (const option of dim.options || []) {
      const optionEl = document.createElement("option");
      optionEl.value = String(option.value);
      optionEl.textContent = option.label;
      select.append(optionEl);
    }
    select.addEventListener("change", handleCommandInput);
    return select;
  }

  if (dim.type === "toggle") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.addEventListener("change", handleCommandInput);
    return input;
  }

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(dim.min);
  input.max = String(dim.max);
  input.step = String(dim.step || 0.01);
  input.addEventListener("pointerdown", () => {
    state.draggingCommandSlider = true;
  });
  input.addEventListener("input", handleCommandInput);
  input.addEventListener("change", finishSliderDrag);
  input.addEventListener("pointerup", finishSliderDrag);
  input.addEventListener("pointercancel", finishSliderDrag);
  return input;
}

function formatCommandValue(dim, value) {
  if (dim.type === "select") {
    const option = (dim.options || []).find((item) => Number(item.value) === Number(value));
    return option ? option.label : String(value);
  }
  if (dim.type === "toggle") {
    return Number(value) === Number(dim.max) ? "On" : "Off";
  }
  return signed(value);
}

function mjPos(value) {
  return new THREE.Vector3(value[0], value[2], -value[1]);
}

function threeToMjPos(value) {
  return [value.x, -value.z, value.y];
}

function mjQuat(value) {
  return new THREE.Quaternion(-value[1], -value[3], value[2], -value[0]).normalize();
}

el.run.addEventListener("click", toggleSimulation);

el.reset.addEventListener("click", resetSimulation);

el.switchPolicy.addEventListener("click", async () => {
  renderStatus(await post("/api/control", { action: "switch_policy" }));
});

el.follow.addEventListener("click", () => {
  state.follow = !state.follow;
  el.follow.setAttribute("aria-pressed", String(state.follow));
});

el.contacts.addEventListener("click", () => {
  state.showContacts = !state.showContacts;
  el.contacts.setAttribute("aria-pressed", String(state.showContacts));
  if (!state.showContacts) {
    updateContacts([]);
  }
});

el.viewHome.addEventListener("click", resetView);

el.drag.addEventListener("click", () => {
  state.dragEnabled = !state.dragEnabled;
  el.drag.setAttribute("aria-pressed", String(state.dragEnabled));
});

window.addEventListener("keydown", (event) => {
  if (event.code === "Space") {
    event.preventDefault();
    if (!event.repeat) {
      toggleSimulation();
    }
    return;
  }
  if (event.code === "Backspace") {
    event.preventDefault();
    resetSimulation();
    return;
  }
  if (!state.commandHotkeys.has(event.code)) {
    return;
  }
  event.preventDefault();
  if (state.keys.has(event.code)) {
    return;
  }
  state.keys.add(event.code);
  state.keyboardCommandActive = true;
  sendKeyboardCommand();
});

window.addEventListener("keyup", (event) => {
  if (!state.commandHotkeys.has(event.code)) {
    return;
  }
  event.preventDefault();
  if (!state.keys.has(event.code)) {
    return;
  }
  state.keys.delete(event.code);
  state.keyboardCommandActive = state.keys.size > 0;
  sendKeyboardCommand();
});

async function main() {
  try {
    el.loading.textContent = "Preparing viewer";
    initRenderer();
    el.loading.textContent = "Loading scene";
    el.follow.setAttribute("aria-pressed", "true");
    el.contacts.setAttribute("aria-pressed", "false");
    el.drag.setAttribute("aria-pressed", "true");
    await loadScene();
    resetView();
    frameLoop();
  } catch (error) {
    el.loading.hidden = false;
    el.loading.textContent = `Failed to load viewer: ${error.message}`;
    setConnection(false);
  }
}

main();

function SimpleOrbitControls(camera, domElement) {
  this.camera = camera;
  this.domElement = domElement;
  this.target = new THREE.Vector3();
  this.radius = 4.8;
  this.theta = Math.PI / 4;
  this.phi = Math.PI / 3;
  this.dragging = false;
  this.panning = false;
  this.enabled = true;
  this.lastX = 0;
  this.lastY = 0;

  const pointerDown = (event) => {
    if (!this.enabled || event.defaultPrevented) {
      return;
    }
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) {
      return;
    }
    this.dragging = true;
    this.panning = event.button === 1 || event.button === 2;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    domElement.setPointerCapture?.(event.pointerId);
  };
  const pointerMove = (event) => {
    if (!this.dragging) {
      return;
    }
    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    if (this.panning) {
      const scale = this.radius * 0.0012;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      this.target.addScaledVector(right, -dx * scale);
      this.target.addScaledVector(up, dy * scale);
    } else {
      this.theta -= dx * 0.0045;
      this.phi = Math.max(0.18, Math.min(Math.PI - 0.18, this.phi - dy * 0.0045));
    }
  };
  const pointerUp = (event) => {
    this.dragging = false;
    domElement.releasePointerCapture?.(event.pointerId);
  };
  const wheel = (event) => {
    event.preventDefault();
    this.radius = Math.max(0.8, Math.min(14, this.radius * Math.exp(event.deltaY * 0.001)));
  };

  domElement.addEventListener("pointerdown", pointerDown);
  domElement.addEventListener("pointermove", pointerMove);
  domElement.addEventListener("pointerup", pointerUp);
  domElement.addEventListener("pointercancel", pointerUp);
  domElement.addEventListener("wheel", wheel, { passive: false });
  domElement.addEventListener("contextmenu", (event) => event.preventDefault());

  this.update = () => {
    const sinPhi = Math.sin(this.phi);
    camera.position.set(
      this.target.x + this.radius * sinPhi * Math.sin(this.theta),
      this.target.y + this.radius * Math.cos(this.phi),
      this.target.z + this.radius * sinPhi * Math.cos(this.theta),
    );
    camera.lookAt(this.target);
  };
}

function buildForceVectorViz() {
  const group = new THREE.Group();
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xff6247,
    emissive: 0x5f1208,
    emissiveIntensity: 0.35,
    roughness: 0.32,
    metalness: 0.05,
    clearcoat: 0.35,
  });
  const tailMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffc857,
    emissive: 0x402000,
    emissiveIntensity: 0.2,
    roughness: 0.4,
  });

  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.026, 1, 24), material);
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.075, 1, 32), material);
  const tail = new THREE.Mesh(new THREE.SphereGeometry(0.045, 24, 12), tailMaterial);
  shaft.castShadow = true;
  head.castShadow = true;
  tail.castShadow = true;
  group.add(shaft, head, tail);
  group.userData.shaft = shaft;
  group.userData.head = head;
  group.visible = false;
  return group;
}

function setForceVectorViz(group, origin, vector) {
  const length = Math.min(vector.length(), 1.35);
  if (length < 1e-5) {
    group.visible = false;
    return;
  }
  const direction = vector.clone().normalize();
  const headLength = Math.min(0.24, Math.max(0.13, length * 0.32));
  const shaftLength = Math.max(0.02, length - headLength);
  const shaft = group.userData.shaft;
  const head = group.userData.head;

  group.visible = true;
  group.position.copy(origin);
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  shaft.position.y = shaftLength * 0.5;
  shaft.scale.set(1, shaftLength, 1);
  head.position.y = shaftLength + headLength * 0.5;
  head.scale.set(1, headLength, 1);
}

function forceDragOffset(offset) {
  const length = offset.length();
  if (length <= 1e-9) {
    return new THREE.Vector3();
  }
  return offset.clone().setLength(Math.min(length, FORCE_DRAG_MAX_OFFSET));
}

function dragForceFromOffset(offset) {
  const force = forceDragOffset(offset).multiplyScalar(FORCE_DRAG_GAIN);
  if (force.length() > FORCE_DRAG_MAX) {
    force.setLength(FORCE_DRAG_MAX);
  }
  return force;
}

function forceArrowVector(offset) {
  const force = dragForceFromOffset(offset);
  const forceNorm = force.length();
  if (forceNorm <= 1e-5) {
    return new THREE.Vector3();
  }
  return force.setLength((forceNorm / FORCE_DRAG_MAX) * FORCE_ARROW_MAX_LENGTH);
}

function buildTorqueCubeViz() {
  const group = new THREE.Group();
  const cubeGeometry = new THREE.BoxGeometry(0.34, 0.34, 0.34);
  const cube = new THREE.Mesh(
    cubeGeometry,
    new THREE.MeshPhysicalMaterial({
      color: 0x5cc8ff,
      emissive: 0x09344a,
      emissiveIntensity: 0.3,
      transparent: true,
      opacity: 0.58,
      roughness: 0.28,
      metalness: 0.08,
      clearcoat: 0.4,
    }),
  );
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(cubeGeometry),
    new THREE.LineBasicMaterial({ color: 0xe7fbff, transparent: true, opacity: 0.9 }),
  );
  const markerX = new THREE.Mesh(
    new THREE.BoxGeometry(0.026, 0.12, 0.12),
    new THREE.MeshBasicMaterial({ color: 0xff6b6b }),
  );
  const markerY = new THREE.Mesh(
    new THREE.BoxGeometry(0.13, 0.026, 0.13),
    new THREE.MeshBasicMaterial({ color: 0x7dff9b }),
  );
  const markerZ = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.12, 0.026),
    new THREE.MeshBasicMaterial({ color: 0x75a7ff }),
  );
  markerX.position.x = 0.183;
  markerY.position.y = 0.183;
  markerZ.position.z = 0.183;
  cube.castShadow = true;
  group.add(cube, edges, markerX, markerY, markerZ);
  group.visible = false;
  return group;
}

function setTorqueCubeViz(group, origin, torque) {
  const amount = torque.length();
  group.visible = true;
  group.position.copy(origin);
  group.scale.setScalar(1 + Math.min(amount / 90, 0.4));
  if (amount < 1e-5) {
    group.quaternion.identity();
    return;
  }
  const direction = torque.clone().normalize();
  const align = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const twist = new THREE.Quaternion().setFromAxisAngle(direction, amount * 0.055);
  group.quaternion.copy(twist.multiply(align));
}

function DragForceManager(scene, camera, domElement, controls) {
  this.scene = scene;
  this.camera = camera;
  this.domElement = domElement;
  this.controls = controls;
  this.raycaster = new THREE.Raycaster();
  this.pointer = new THREE.Vector2();
  this.active = false;
  this.bodyId = null;
  this.bodyObject = null;
  this.mode = "force";
  this.grabDistance = 0;
  this.localHit = new THREE.Vector3();
  this.bodyLocalHit = new THREE.Vector3();
  this.worldHit = new THREE.Vector3();
  this.currentWorld = new THREE.Vector3();
  this.torque = new THREE.Vector3();
  this.startX = 0;
  this.startY = 0;
  this.lastSend = 0;

  this.forceViz = buildForceVectorViz();
  this.torqueViz = buildTorqueCubeViz();
  scene.add(this.forceViz);
  scene.add(this.torqueViz);

  const updateRay = (event) => {
    const rect = domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, camera);
  };

  const pointerDown = (event) => {
    if (!state.dragEnabled || (event.button !== 0 && event.button !== 2) || !state.sceneLoaded) {
      return;
    }
    updateRay(event);
    const hits = this.raycaster.intersectObjects(three.draggableMeshes, true);
    const hit = hits.find((item) => Number.isInteger(item.object.userData.bodyId));
    if (!hit) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.active = true;
    state.draggingForce = true;
    this.controls.enabled = false;
    this.mode = event.button === 2 ? "torque" : "force";
    this.bodyId = hit.object.userData.bodyId;
    this.bodyObject = three.bodies.get(this.bodyId);
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.torque.set(0, 0, 0);
    this.grabDistance = hit.distance;
    this.localHit.copy(hit.object.worldToLocal(hit.point.clone()));
    this.bodyLocalHit.copy(this.bodyObject.worldToLocal(hit.point.clone()));
    this.worldHit.copy(hit.point);
    this.currentWorld.copy(hit.point);
    this.forceViz.visible = this.mode === "force";
    this.torqueViz.visible = this.mode === "torque";
    this.update();
    domElement.setPointerCapture?.(event.pointerId);
    this.send(true);
  };

  const pointerMove = (event) => {
    if (!this.active) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    updateRay(event);
    if (this.mode === "torque") {
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
      const dragX = event.clientX - this.startX;
      const dragY = event.clientY - this.startY;
      const drag = new THREE.Vector2(dragX, dragY);
      const amount = drag.length();
      if (amount <= TORQUE_DRAG_DEADZONE_PX) {
        this.torque.set(0, 0, 0);
      } else {
        const scale = ((amount - TORQUE_DRAG_DEADZONE_PX) / amount) * TORQUE_DRAG_GAIN;
        this.torque.copy(up.multiplyScalar(dragX * scale)).add(right.multiplyScalar(dragY * scale));
      }
      if (this.torque.length() > TORQUE_DRAG_MAX) {
        this.torque.setLength(TORQUE_DRAG_MAX);
      }
    } else {
      this.currentWorld.copy(this.raycaster.ray.origin).addScaledVector(
        this.raycaster.ray.direction,
        this.grabDistance,
      );
    }
    this.update();
    const now = performance.now();
    if (now - this.lastSend >= 35) {
      this.send(true);
      this.lastSend = now;
    }
  };

  const pointerUp = (event) => {
    if (!this.active) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.send(false);
    this.active = false;
    state.draggingForce = false;
    this.bodyId = null;
    this.bodyObject = null;
    this.mode = "force";
    this.torque.set(0, 0, 0);
    this.controls.enabled = true;
    this.forceViz.visible = false;
    this.torqueViz.visible = false;
    domElement.releasePointerCapture?.(event.pointerId);
  };

  domElement.addEventListener("pointerdown", pointerDown, true);
  domElement.addEventListener("pointermove", pointerMove, true);
  domElement.addEventListener("pointerup", pointerUp, true);
  domElement.addEventListener("pointercancel", pointerUp, true);

  this.update = () => {
    if (this.bodyId === null) {
      return;
    }
    const body = this.bodyObject || three.bodies.get(this.bodyId);
    if (!body) {
      return;
    }
    this.worldHit.copy(this.bodyLocalHit);
    body.localToWorld(this.worldHit);
    const offset = this.currentWorld.clone().sub(this.worldHit);
    if (this.mode === "torque") {
      const bodyCenter = new THREE.Vector3();
      body.getWorldPosition(bodyCenter);
      this.forceViz.visible = false;
      setTorqueCubeViz(this.torqueViz, bodyCenter, this.torque);
    } else {
      this.torqueViz.visible = false;
      setForceVectorViz(this.forceViz, this.worldHit, forceArrowVector(offset));
    }
  };

  this.send = (active) => {
    if (!active || this.bodyId === null) {
      post("/api/drag", { active: false }).catch(() => {});
      return;
    }
    this.update();
    if (this.mode === "torque") {
      post("/api/drag", {
        active: true,
        body_id: this.bodyId,
        point: threeToMjPos(this.worldHit),
        force: [0, 0, 0],
        torque: threeToMjPos(this.torque),
      }).catch(() => {});
      return;
    }
    const offset = this.currentWorld.clone().sub(this.worldHit);
    const force = dragForceFromOffset(offset);
    const body = this.bodyObject || three.bodies.get(this.bodyId);
    const bodyCenter = new THREE.Vector3();
    if (body) {
      body.getWorldPosition(bodyCenter);
    }
    const torque = this.worldHit.clone().sub(bodyCenter).cross(force.clone());
    post("/api/drag", {
      active: true,
      body_id: this.bodyId,
      point: threeToMjPos(this.worldHit),
      force: threeToMjPos(force),
      torque: threeToMjPos(torque),
    }).catch(() => {});
  };
}
