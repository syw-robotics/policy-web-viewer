import * as THREE from 'three';
import loadMujoco from 'mujoco-js';
import * as ort from 'onnxruntime-web';
import {
  CAMERA_CONFIG,
  CONTACT_CONFIG,
  FLOOR_CONFIG,
  FORCE_CONFIG,
  GEOM_MATERIAL_CONFIG,
  HOME_VIEW,
  LIGHT_CONFIG,
  ORBIT_CONFIG,
  RUNTIME_CONFIG,
  SCENE_CONFIG,
  SHADOW_CONFIG,
  TORQUE_CONFIG,
  formatHomeViewOverlay,
} from '../render_config.js';

const MANIFEST_URL = './demo/manifest.json';
const FORCE_DRAG_MAX_OFFSET = FORCE_CONFIG.dragMax / FORCE_CONFIG.dragGain;

const el = {
  viewport: document.querySelector('#viewport'),
  loading: document.querySelector('#loading'),
  run: document.querySelector('#run'),
  reset: document.querySelector('#reset'),
  viewHome: document.querySelector('#view-home'),
  follow: document.querySelector('#follow'),
  contacts: document.querySelector('#contacts'),
  drag: document.querySelector('#drag'),
  subtitle: document.querySelector('#subtitle'),
  policy: document.querySelector('#policy'),
  time: document.querySelector('#time'),
  height: document.querySelector('#height'),
  performance: document.querySelector('#performance'),
  connection: document.querySelector('#connection'),
  commandControls: document.querySelector('#command-controls'),
  commandHelp: document.querySelector('#command-help'),
  viewParams: null,
};

class RuntimeDemo {
  constructor(mujoco, manifest) {
    this.mujoco = mujoco;
    this.manifest = manifest;
    this.config = null;
    this.commandSchema = null;
    this.command = [];
    this.commandControls = [];
    this.commandHotkeys = new Set();
    this.keyboardCommandActive = false;
    this.keys = new Set();
    this.running = false;
    this.follow = true;
    this.showContacts = false;
    this.dragEnabled = true;
    this.alive = false;

    this.model = null;
    this.data = null;
    this.sim = null;
    this.policy = null;
    this.bodies = new Map();
    this.draggableMeshes = [];
    this.bodyNameToId = new Map();

    this.actionTarget = null;
    this.targetQ = null;
    this.kp = null;
    this.kd = null;
    this.ctrl = null;
    this.lastPolicyTime = -Infinity;
    this.simSteps = 0;
    this.lastRtfSteps = 0;
    this.lastRtfTime = performance.now();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SCENE_CONFIG.background);
    this.scene.fog = new THREE.Fog(SCENE_CONFIG.background, SCENE_CONFIG.fogNear, SCENE_CONFIG.fogFar);
    this.camera = new THREE.PerspectiveCamera(CAMERA_CONFIG.fov, 1, CAMERA_CONFIG.near, CAMERA_CONFIG.far);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, SCENE_CONFIG.maxPixelRatio));
    el.viewport.appendChild(this.renderer.domElement);
    this.initViewParamsOverlay();

    this.controls = new SimpleOrbitControls(this.camera, this.renderer.domElement);

    this.followTarget = new THREE.Vector3(...HOME_VIEW.target);
    this.followLerp = 0.08;
    this.followBodyId = null;
    this.contactGroup = new THREE.Group();
    this.contactGroup.visible = false;
    this.contactVisuals = [];
    this.contactForce = new Float64Array(6);
    this.scene.add(this.contactGroup);
    this.dragger = new DragForceManager(this);

    this.scene.add(new THREE.HemisphereLight(
      LIGHT_CONFIG.hemisphereSky,
      LIGHT_CONFIG.hemisphereGround,
      LIGHT_CONFIG.hemisphereIntensity,
    ));
    this.keyLight = new THREE.DirectionalLight(LIGHT_CONFIG.keyColor, LIGHT_CONFIG.keyIntensity);
    this.keyLight.position.set(...LIGHT_CONFIG.keyOffset);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(SHADOW_CONFIG.mapSize, SHADOW_CONFIG.mapSize);
    this.keyLight.shadow.camera.near = SHADOW_CONFIG.near;
    this.keyLight.shadow.camera.far = SHADOW_CONFIG.far;
    this.keyLight.shadow.camera.left = SHADOW_CONFIG.left;
    this.keyLight.shadow.camera.right = SHADOW_CONFIG.right;
    this.keyLight.shadow.camera.top = SHADOW_CONFIG.top;
    this.keyLight.shadow.camera.bottom = SHADOW_CONFIG.bottom;
    this.keyLightTarget = new THREE.Object3D();
    this.keyLight.target = this.keyLightTarget;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLightTarget);

    const rim = new THREE.DirectionalLight(LIGHT_CONFIG.rimColor, LIGHT_CONFIG.rimIntensity);
    rim.position.set(...LIGHT_CONFIG.rimPosition);
    this.scene.add(rim);

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (event) => this.handleKeyDown(event));
    window.addEventListener('keyup', (event) => this.handleKeyUp(event));
    this.resize();
    this.resetView();
    this.renderer.setAnimationLoop(() => this.render());
  }

  async init() {
    this.mujoco.FS.mkdir('/working');
    this.mujoco.FS.mount(this.mujoco.MEMFS, { root: '.' }, '/working');
    await this.preloadSceneFiles();
    await this.loadScene();
    await this.loadPolicy();
    this.reset();
    this.alive = true;
    this.mainLoop();
  }

  async preloadSceneFiles() {
    const files = await fetchJson('./demo/scenes/files.json');
    await Promise.all(files.map(async (file) => {
      const response = await fetch(`./demo/scenes/${file}`);
      if (!response.ok) {
        throw new Error(`failed to load scene asset ${file}: ${response.status}`);
      }
      let cursor = '/working';
      const parts = file.split('/');
      for (let i = 0; i < parts.length - 1; i++) {
        cursor += `/${parts[i]}`;
        if (!this.mujoco.FS.analyzePath(cursor).exists) {
          this.mujoco.FS.mkdir(cursor);
        }
      }
      const target = `/working/${file}`;
      if (/\.(stl|png|jpg|jpeg|skn)$/i.test(file)) {
        this.mujoco.FS.writeFile(target, new Uint8Array(await response.arrayBuffer()));
      } else {
        this.mujoco.FS.writeFile(target, await response.text());
      }
    }));
  }

  async loadScene() {
    this.model = this.mujoco.MjModel.loadFromXML(`/working/${this.manifest.scene_xml}`);
    this.data = new this.mujoco.MjData(this.model);
    this.sim = createSimulationWrapper(this.mujoco, this.model, this.data);
    if (this.manifest.physics_dt && this.model.opt) {
      this.model.opt.timestep = Number(this.manifest.physics_dt);
    }
    this.buildSceneObjects();
    this.configureJointMappings();
  }

  async loadPolicy() {
    this.config = await fetchJson('./demo/policy/policy.json');
    this.commandSchema = this.config.command_schema;
    this.command = defaultCommand(this.commandSchema);
    buildCommandControls(this);
    updateCommandControls(this);
    updateCommandHelp(this.commandSchema);
    this.policy = new BrowserPolicy(this.config);
    await this.policy.init();
    this.targetQ = new Float64Array(this.model.nu);
    this.kp = new Float64Array(this.model.nu);
    this.kd = new Float64Array(this.model.nu);
    this.ctrl = new Float64Array(this.model.nu);
    el.subtitle.textContent = `${this.manifest.robot} / ${this.manifest.terrain}`;
    el.policy.textContent = this.manifest.policy || 'default';
  }

  configureJointMappings() {
    const jointNames = readNames(this.model, 'jnt');
    const actuatorJointIds = [];
    for (let i = 0; i < this.model.nu; i++) {
      actuatorJointIds.push(this.model.actuator_trnid[i * 2]);
    }
    const actuatorJointNames = actuatorJointIds.map((jointId) => jointNames[jointId]);
    const sdkIndex = new Map(this.manifest.sdk_joint_order.map((name, i) => [name, i]));
    this.sdkToActuator = actuatorJointNames.map((name) => sdkIndex.has(name) ? sdkIndex.get(name) : -1);
    this.motorQposAdr = actuatorJointIds.map((jointId) => this.model.jnt_qposadr[jointId]);
    this.motorDofAdr = actuatorJointIds.map((jointId) => this.model.jnt_dofadr[jointId]);
    this.ctrlLower = new Float64Array(this.model.nu);
    this.ctrlUpper = new Float64Array(this.model.nu);
    for (let i = 0; i < this.model.nu; i++) {
      this.ctrlLower[i] = this.model.actuator_ctrlrange[i * 2];
      this.ctrlUpper[i] = this.model.actuator_ctrlrange[i * 2 + 1];
    }
    this.obsQposAdr = this.manifest.obs_joint_order.map((name) => {
      const idx = jointNames.indexOf(name);
      if (idx < 0) throw new Error(`policy joint ${name} not found`);
      return this.model.jnt_qposadr[idx];
    });
    this.obsDofAdr = this.manifest.obs_joint_order.map((name) => {
      const idx = jointNames.indexOf(name);
      return this.model.jnt_dofadr[idx];
    });
  }

  buildSceneObjects() {
    const root = new THREE.Group();
    root.name = 'MuJoCo Root';
    this.scene.add(root);
    const bodyNames = readNames(this.model, 'body');
    const meshCache = new Map();

    for (let bodyId = 0; bodyId < this.model.nbody; bodyId++) {
      const group = new THREE.Group();
      group.name = bodyNames[bodyId] || `body_${bodyId}`;
      group.bodyID = bodyId;
      this.bodies.set(bodyId, group);
      this.bodyNameToId.set(group.name, bodyId);
      root.add(group);
      if (group.name === 'pelvis' || group.name === 'base') {
        this.followBodyId = bodyId;
      }
    }
    if (this.followBodyId === null && this.model.nbody > 1) {
      this.followBodyId = 1;
    }

    for (let geomId = 0; geomId < this.model.ngeom; geomId++) {
      if (!(this.model.geom_group[geomId] < 3)) {
        continue;
      }
      const bodyId = this.model.geom_bodyid[geomId];
      const body = this.bodies.get(bodyId);
      if (!body) {
        continue;
      }
      const mesh = this.buildGeom(geomId, meshCache);
      if (!mesh) {
        continue;
      }
      mesh.bodyID = bodyId;
      mesh.castShadow = this.model.geom_type[geomId] !== this.mujoco.mjtGeom.mjGEOM_PLANE.value;
      mesh.receiveShadow = true;
      getPosition(this.model.geom_pos, geomId, mesh.position);
      if (this.model.geom_type[geomId] !== this.mujoco.mjtGeom.mjGEOM_PLANE.value) {
        getQuaternion(this.model.geom_quat, geomId, mesh.quaternion);
        this.draggableMeshes.push(mesh);
      }
      body.add(mesh);
    }
  }

  buildGeom(geomId, meshCache) {
    const type = this.model.geom_type[geomId];
    const size = [
      this.model.geom_size[geomId * 3],
      this.model.geom_size[geomId * 3 + 1],
      this.model.geom_size[geomId * 3 + 2],
    ];
    let geometry = null;
    if (type === this.mujoco.mjtGeom.mjGEOM_PLANE.value) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_CONFIG.size, FLOOR_CONFIG.size), floorMaterial());
      mesh.rotation.x = -Math.PI / 2;
      return mesh;
    }
    if (type === this.mujoco.mjtGeom.mjGEOM_SPHERE.value) {
      geometry = new THREE.SphereGeometry(size[0], 32, 16);
    } else if (type === this.mujoco.mjtGeom.mjGEOM_CAPSULE.value) {
      geometry = new THREE.CapsuleGeometry(size[0], size[1] * 2, 16, 24);
    } else if (type === this.mujoco.mjtGeom.mjGEOM_ELLIPSOID.value) {
      geometry = new THREE.SphereGeometry(1, 32, 16);
    } else if (type === this.mujoco.mjtGeom.mjGEOM_CYLINDER.value) {
      geometry = new THREE.CylinderGeometry(size[0], size[0], size[1] * 2, 32);
    } else if (type === this.mujoco.mjtGeom.mjGEOM_BOX.value) {
      geometry = new THREE.BoxGeometry(size[0] * 2, size[2] * 2, size[1] * 2);
    } else if (type === this.mujoco.mjtGeom.mjGEOM_MESH.value) {
      geometry = meshGeometry(this.model, this.model.geom_dataid[geomId], meshCache);
    }
    if (!geometry) {
      return null;
    }
    const mesh = new THREE.Mesh(geometry, materialForGeom(this.model, geomId));
    if (type === this.mujoco.mjtGeom.mjGEOM_ELLIPSOID.value) {
      mesh.scale.set(size[0], size[2], size[1]);
    }
    return mesh;
  }

  reset() {
    this.sim.resetData();
    if (Array.isArray(this.manifest.initial_qpos)) {
      this.sim.qpos.set(this.manifest.initial_qpos);
    }
    this.sim.qvel.fill(0);
    this.sim.ctrl.fill(0);
    this.sim.forward();
    this.policy?.reset();
    this.lastPolicyTime = -Infinity;
    this.simSteps = 0;
    this.lastRtfSteps = 0;
    this.lastRtfTime = performance.now();
    this.updateCachedBodies();
  }

  async mainLoop() {
    while (this.alive) {
      const started = performance.now();
      if (this.running) {
        await this.policyStep();
        for (let i = 0; i < this.manifest.decimation; i++) {
          this.applyControl();
          this.applyDragForce();
          this.sim.step();
          this.simSteps += 1;
        }
        this.updateCachedBodies();
      }
      this.updateContacts();
      const now = performance.now();
      if (now - this.lastRtfTime >= 1000) {
        const simHz = Number(this.manifest.sim_hz || RUNTIME_CONFIG.defaultSimHz);
        const stepDelta = this.simSteps - this.lastRtfSteps;
        const rtf = stepDelta / (simHz * ((now - this.lastRtfTime) / 1000));
        el.performance.textContent = `${rtf.toFixed(2)} RTF`;
        this.lastRtfSteps = this.simSteps;
        this.lastRtfTime = now;
      }
      this.updateReadouts();
      const elapsed = (performance.now() - started) / 1000;
      await sleep(Math.max(0, this.manifest.policy_step_dt - elapsed) * 1000);
    }
  }

  async policyStep() {
    const context = {
      q: gather(this.sim.qpos, this.obsQposAdr),
      dq: gather(this.sim.qvel, this.obsDofAdr),
      quat: Array.from(this.sim.qpos.slice(3, 7)),
      gyro: this.readGyro(),
      command: this.command.slice(),
    };
    const targetObs = await this.policy.computeTargetQ(context);
    const targetSdk = this.manifest.obs_to_sdk.map((idx) => targetObs[idx]);
    for (let i = 0; i < this.model.nu; i++) {
      const sdkIdx = this.sdkToActuator[i];
      this.targetQ[i] = this.sim.qpos[this.motorQposAdr[i]];
      this.kp[i] = 0;
      this.kd[i] = 0;
      if (sdkIdx >= 0) {
        this.targetQ[i] = targetSdk[sdkIdx];
        this.kp[i] = this.manifest.kp_policy[sdkIdx];
        this.kd[i] = this.manifest.kd_policy[sdkIdx];
      }
    }
  }

  applyControl() {
    for (let i = 0; i < this.model.nu; i++) {
      const q = this.sim.qpos[this.motorQposAdr[i]];
      const dq = this.sim.qvel[this.motorDofAdr[i]];
      const raw = this.kp[i] * (this.targetQ[i] - q) - this.kd[i] * dq;
      this.ctrl[i] = clamp(raw, this.ctrlLower[i], this.ctrlUpper[i]);
      this.sim.ctrl[i] = this.ctrl[i];
    }
    this.sim.qfrc_applied.fill(0);
  }

  applyDragForce() {
    if (!this.dragEnabled || !this.dragger.active || this.dragger.bodyId === null) {
      return;
    }
    if (performance.now() > this.dragger.deadline) {
      this.dragger.cancel();
      return;
    }
    if (this.dragger.mode === 'torque') {
      const torque = threeToMj(this.dragger.torque.clone());
      const bodyCenter = new THREE.Vector3();
      this.dragger.bodyObject?.getWorldPosition(bodyCenter);
      const point = threeToMj(bodyCenter);
      this.sim.applyForce(0, 0, 0, torque.x, torque.y, torque.z, point.x, point.y, point.z, this.dragger.bodyId);
      return;
    }
    const offset = this.dragger.currentWorld.clone().sub(this.dragger.worldHit);
    const force = dragForceFromOffset(offset);
    const bodyCenter = new THREE.Vector3();
    if (this.dragger.bodyObject) {
      this.dragger.bodyObject.getWorldPosition(bodyCenter);
    }
    const torque = this.dragger.worldHit.clone().sub(bodyCenter).cross(force.clone());
    const point = threeToMj(this.dragger.worldHit.clone());
    const f = threeToMj(force);
    const t = threeToMj(torque);
    this.sim.applyForce(f.x, f.y, f.z, t.x, t.y, t.z, point.x, point.y, point.z, this.dragger.bodyId);
  }

  readGyro() {
    if (Array.isArray(this.manifest.gyro_sensor) && this.manifest.gyro_sensor.length >= 2) {
      const adr = Number(this.manifest.gyro_sensor[0]);
      const dim = Number(this.manifest.gyro_sensor[1]);
      if (Number.isInteger(adr) && dim >= 3 && this.data.sensordata) {
        return Array.from(this.data.sensordata.slice(adr, adr + 3));
      }
    }
    return Array.from(this.sim.qvel.slice(3, 6));
  }

  updateCachedBodies() {
    for (let bodyId = 0; bodyId < this.model.nbody; bodyId++) {
      const body = this.bodies.get(bodyId);
      if (!body) continue;
      getPosition(this.sim.xpos, bodyId, body.position);
      getQuaternion(this.sim.xquat, bodyId, body.quaternion);
    }
  }

  updateContacts() {
    this.contactGroup.visible = this.showContacts;
    if (!this.showContacts || !this.data?.contact) {
      this.hideUnusedContacts(0);
      return;
    }

    const count = Math.max(0, Number(this.data.ncon || 0));
    for (let i = 0; i < count; i++) {
      const contact = this.data.contact.get(i);
      if (!contact) {
        continue;
      }
      const viz = this.contactVizAt(i);
      viz.visible = true;
      viz.position.set(contact.pos[0], contact.pos[2], -contact.pos[1]);
      viz.userData.point.position.set(0, 0, 0);
      const force = this.contactForceWorld(i, contact);
      setForceVectorViz(viz.userData.arrow, new THREE.Vector3(), contactForceVector(force));
    }
    this.hideUnusedContacts(count);
  }

  contactVizAt(index) {
    while (this.contactVisuals.length <= index) {
      const viz = buildContactViz();
      this.contactVisuals.push(viz);
      this.contactGroup.add(viz);
    }
    return this.contactVisuals[index];
  }

  hideUnusedContacts(start) {
    for (let i = start; i < this.contactVisuals.length; i++) {
      this.contactVisuals[i].visible = false;
    }
  }

  contactForceWorld(index, contact) {
    this.contactForce.fill(0);
    this.mujoco.mj_contactForce(this.model, this.data, index, this.contactForce);
    let localX = this.contactForce[0];
    let localY = this.contactForce[1];
    let localZ = this.contactForce[2];
    if (Math.hypot(localX, localY, localZ) <= 1e-9) {
      localX = this.contactNormalForceFallback(contact);
      localY = 0;
      localZ = 0;
    }
    const frame = contact.frame;
    return new THREE.Vector3(
      frame[0] * localX + frame[3] * localY + frame[6] * localZ,
      frame[2] * localX + frame[5] * localY + frame[8] * localZ,
      -(frame[1] * localX + frame[4] * localY + frame[7] * localZ),
    );
  }

  contactNormalForceFallback(contact) {
    const address = Number(contact.efc_address);
    const dim = Math.max(1, Number(contact.dim || 1));
    if (!Number.isInteger(address) || address < 0 || !this.data?.efc_force) {
      return 0;
    }
    let normal = 0;
    const end = Math.min(address + dim, this.data.efc_force.length);
    for (let i = address; i < end; i++) {
      normal += Math.abs(Number(this.data.efc_force[i] || 0));
    }
    return normal;
  }

  updateFollow() {
    if (this.followBodyId === null) {
      return;
    }
    const body = this.bodies.get(this.followBodyId);
    if (!body) return;
    const desired = new THREE.Vector3(body.position.x, 0.85, body.position.z);
    this.updateShadowFollow(desired);
    if (!this.follow) {
      return;
    }
    this.followTarget.lerp(desired, this.followLerp);
    const delta = desired.clone().sub(this.controls.target);
    this.controls.target.add(delta);
  }

  updateShadowFollow(target) {
    this.keyLightTarget.position.copy(target);
    this.keyLight.position.copy(target).add(new THREE.Vector3(...LIGHT_CONFIG.keyOffset));
    this.keyLightTarget.updateMatrixWorld();
    this.keyLight.updateMatrixWorld();
  }

  updateReadouts() {
    el.run.textContent = this.running ? 'Pause' : 'Start';
    el.time.textContent = `${Number(this.sim.qpos ? this.data.time : 0).toFixed(3)} s`;
    el.height.textContent = `${Number(this.sim.qpos[2] || 0).toFixed(3)} m`;
  }

  resetView() {
    const target = new THREE.Vector3(...HOME_VIEW.target);
    const position = new THREE.Vector3(...HOME_VIEW.position);
    const offset = position.sub(target);
    const radius = Math.max(offset.length(), 0.001);
    this.controls.target.copy(target);
    this.followTarget.copy(target);
    this.controls.radius = radius;
    this.controls.theta = Math.atan2(offset.x, offset.z);
    this.controls.phi = Math.acos(Math.max(-1, Math.min(1, offset.y / radius)));
    this.controls.update();
  }

  handleKeyDown(event) {
    if (event.code === 'Space') {
      event.preventDefault();
      if (!event.repeat) {
        this.running = !this.running;
      }
      return;
    }
    if (event.code === 'Backspace') {
      event.preventDefault();
      this.reset();
      return;
    }
    if (!this.commandHotkeys.has(event.code)) {
      return;
    }
    event.preventDefault();
    if (this.keys.has(event.code)) {
      return;
    }
    this.keys.add(event.code);
    this.keyboardCommandActive = true;
    this.applyKeyboardCommand();
  }

  handleKeyUp(event) {
    if (!this.commandHotkeys.has(event.code)) {
      return;
    }
    event.preventDefault();
    if (!this.keys.has(event.code)) {
      return;
    }
    this.keys.delete(event.code);
    this.keyboardCommandActive = this.keys.size > 0;
    this.applyKeyboardCommand();
  }

  applyKeyboardCommand() {
    this.command = keyCommand(this.commandSchema, this.keys);
    updateCommandControls(this);
  }

  resize() {
    const { clientWidth, clientHeight } = el.viewport;
    this.camera.aspect = clientWidth / Math.max(clientHeight, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(clientWidth, clientHeight, false);
  }

  initViewParamsOverlay() {
    if (!RUNTIME_CONFIG.showViewParams) {
      return;
    }
    el.viewParams = document.createElement('pre');
    el.viewParams.className = 'view-params';
    el.viewport.appendChild(el.viewParams);
  }

  updateViewParamsOverlay() {
    if (!el.viewParams || !this.controls) {
      return;
    }
    el.viewParams.textContent = formatHomeViewOverlay(this.controls);
  }

  render() {
    if (!this.model) {
      return;
    }
    this.updateFollow();
    this.controls.update();
    this.dragger.update();
    this.updateViewParamsOverlay();
    this.renderer.render(this.scene, this.camera);
  }
}

class BrowserPolicy {
  constructor(config) {
    this.config = config;
    this.action = new Float32Array(config.action_dim);
    this.targetQ = Float32Array.from(config.default_joint_pos_obs);
    this.previousActionObs = null;
    this.needsPrime = Boolean(config.obs_prime_on_reset);
    this.observation = new ObservationGroup(config.observations.map((spec) => this.buildObservation(spec)), config.obs_group_concat_mode);
  }

  async init() {
    const response = await fetch(this.config.onnx_path);
    if (!response.ok) {
      throw new Error(`failed to load ONNX policy: ${response.status}`);
    }
    this.session = await ort.InferenceSession.create(await response.arrayBuffer(), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  }

  buildObservation(spec) {
    let obs;
    if (spec.type === 'base_ang_vel') {
      obs = new ObservationTerm(spec, 3, (ctx) => ctx.gyro);
    } else if (spec.type === 'projected_gravity') {
      obs = new ObservationTerm(spec, 3, (ctx) => quatToBodyGravity(ctx.quat));
    } else if (spec.type === 'command') {
      const range = spec.command_range;
      obs = new ObservationTerm(spec, range.length, (ctx) => range.map((r, i) => clamp(ctx.command[i] ?? 0, r[0], r[1])));
    } else if (spec.type === 'joint_pos_rel') {
      const indices = this.config.action_to_obs_indices;
      const defaults = this.config.default_joint_pos_action;
      obs = new ObservationTerm(spec, indices.length, (ctx) => indices.map((idx, i) => ctx.q[idx] - defaults[i]));
    } else if (spec.type === 'joint_pos') {
      const indices = this.config.action_to_obs_indices;
      obs = new ObservationTerm(spec, indices.length, (ctx) => indices.map((idx) => ctx.q[idx]));
    } else if (spec.type === 'joint_vel') {
      const indices = this.config.action_to_obs_indices;
      obs = new ObservationTerm(spec, indices.length, (ctx) => indices.map((idx) => ctx.dq[idx]));
    } else if (spec.type === 'prev_action') {
      obs = new PreviousActionObservation(spec, this.config.action_dim);
      this.previousActionObs = obs;
    } else {
      throw new Error(`unsupported observation type in browser runtime: ${spec.type}`);
    }
    return obs;
  }

  reset() {
    this.action.fill(0);
    this.observation.reset();
    this.needsPrime = Boolean(this.config.obs_prime_on_reset);
  }

  async computeTargetQ(context) {
    if (this.needsPrime) {
      this.observation.prime(context);
      this.needsPrime = false;
    } else {
      this.observation.update(context);
    }
    const obs = this.observation.compute();
    const feeds = {
      [this.config.policy_input_name]: new ort.Tensor('float32', obs, [1, obs.length]),
    };
    const output = await this.session.run(feeds);
    const raw = output[this.config.policy_output_name] || output[this.session.outputNames[0]];
    const actionData = raw.data;
    for (let i = 0; i < this.action.length; i++) {
      this.action[i] = actionData[i] ?? 0;
    }
    const prev = new Float32Array(this.action.length);
    for (let i = 0; i < prev.length; i++) {
      prev[i] = this.config.obs_use_scaled_prev_action
        ? this.action[i] * this.config.action_scaling[i]
        : this.action[i];
    }
    this.previousActionObs?.recordAction(prev);
    const clip = this.config.action_clip;
    this.targetQ.set(this.config.default_joint_pos_obs);
    for (let i = 0; i < this.action.length; i++) {
      const unclipped = this.action[i];
      const action = Number.isFinite(clip) ? clamp(unclipped, -clip, clip) : unclipped;
      const obsIdx = this.config.action_to_obs_indices[i];
      this.targetQ[obsIdx] = this.config.default_joint_pos_action[i] + this.config.action_scaling[i] * action;
    }
    return this.targetQ;
  }
}

class ObservationTerm {
  constructor(spec, baseDim, computeFn) {
    this.spec = spec;
    this.baseDim = baseDim;
    this.historyLen = Number(spec.history_len || 1);
    this.computeFn = computeFn;
    this.buffer = Array.from({ length: this.historyLen }, () => new Float32Array(baseDim));
    this.scale = spec.scale ?? 1.0;
    this.clip = spec.clip ?? null;
  }

  reset() {
    for (const row of this.buffer) row.fill(0);
  }

  prime(ctx) {
    const current = this.current(ctx);
    for (const row of this.buffer) row.set(current);
  }

  update(ctx) {
    const current = this.current(ctx);
    for (let i = 0; i < this.buffer.length - 1; i++) {
      this.buffer[i].set(this.buffer[i + 1]);
    }
    this.buffer[this.buffer.length - 1].set(current);
  }

  current(ctx) {
    const values = this.computeFn(ctx);
    const out = new Float32Array(this.baseDim);
    for (let i = 0; i < this.baseDim; i++) {
      let value = Number(values[i] ?? 0) * this.scale;
      if (Array.isArray(this.clip)) {
        if (this.clip.length === 2 && !Array.isArray(this.clip[0])) {
          value = clamp(value, this.clip[0], this.clip[1]);
        } else if (Array.isArray(this.clip[i])) {
          value = clamp(value, this.clip[i][0], this.clip[i][1]);
        }
      }
      out[i] = value;
    }
    return out;
  }
}

class PreviousActionObservation extends ObservationTerm {
  constructor(spec, actionDim) {
    super(spec, actionDim, () => new Float32Array(actionDim));
  }

  update() {}

  recordAction(action) {
    const values = this.current({ action });
    for (let i = 0; i < this.buffer.length - 1; i++) {
      this.buffer[i].set(this.buffer[i + 1]);
    }
    this.buffer[this.buffer.length - 1].set(values);
  }

  current(ctx) {
    const values = ctx.action || new Float32Array(this.baseDim);
    const out = new Float32Array(this.baseDim);
    for (let i = 0; i < this.baseDim; i++) {
      let value = Number(values[i] ?? 0) * this.scale;
      if (Array.isArray(this.clip) && this.clip.length === 2) {
        value = clamp(value, this.clip[0], this.clip[1]);
      }
      out[i] = value;
    }
    return out;
  }
}

class ObservationGroup {
  constructor(observations, mode = 'term_major') {
    this.observations = observations;
    this.mode = mode || 'term_major';
    this.size = observations.reduce((sum, obs) => sum + obs.baseDim * obs.historyLen, 0);
  }

  reset() {
    for (const obs of this.observations) obs.reset();
  }

  prime(ctx) {
    for (const obs of this.observations) obs.prime(ctx);
  }

  update(ctx) {
    for (const obs of this.observations) obs.update(ctx);
  }

  compute() {
    const out = new Float32Array(this.size);
    let offset = 0;
    if (this.mode === 'history_major' && this.observations.length) {
      const historyLen = this.observations[0].historyLen;
      for (let t = 0; t < historyLen; t++) {
        for (const obs of this.observations) {
          out.set(obs.buffer[t], offset);
          offset += obs.baseDim;
        }
      }
      return out;
    }
    for (const obs of this.observations) {
      for (const row of obs.buffer) {
        out.set(row, offset);
        offset += obs.baseDim;
      }
    }
    return out;
  }
}

class DragForceManager {
  constructor(demo) {
    this.demo = demo;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.active = false;
    this.bodyId = null;
    this.bodyObject = null;
    this.mode = 'force';
    this.grabDistance = 0;
    this.localHit = new THREE.Vector3();
    this.worldHit = new THREE.Vector3();
    this.currentWorld = new THREE.Vector3();
    this.torque = new THREE.Vector3();
    this.startX = 0;
    this.startY = 0;
    this.deadline = 0;
    this.forceViz = buildForceVectorViz();
    this.torqueViz = buildTorqueCubeViz();
    demo.scene.add(this.forceViz);
    demo.scene.add(this.torqueViz);
    demo.renderer.domElement.addEventListener('pointerdown', (event) => this.pointerDown(event), true);
    demo.renderer.domElement.addEventListener('pointermove', (event) => this.pointerMove(event), true);
    demo.renderer.domElement.addEventListener('pointerup', (event) => this.pointerUp(event), true);
    demo.renderer.domElement.addEventListener('pointercancel', (event) => this.pointerUp(event), true);
    demo.renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  updateRay(event) {
    const rect = this.demo.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.demo.camera);
  }

  pointerDown(event) {
    if (!this.demo.dragEnabled || (event.button !== 0 && event.button !== 2)) return;
    this.updateRay(event);
    const hits = this.raycaster.intersectObjects(this.demo.draggableMeshes, true);
    const hit = hits.find((item) => Number.isInteger(item.object.bodyID));
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();
    this.active = true;
    this.mode = event.button === 2 ? 'torque' : 'force';
    this.bodyId = hit.object.bodyID;
    this.bodyObject = this.demo.bodies.get(this.bodyId);
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.torque.set(0, 0, 0);
    this.grabDistance = hit.distance;
    this.localHit.copy(this.bodyObject.worldToLocal(hit.point.clone()));
    this.worldHit.copy(hit.point);
    this.currentWorld.copy(hit.point);
    this.deadline = performance.now() + FORCE_CONFIG.dragDeadlineMs;
    this.demo.controls.enabled = false;
    this.forceViz.visible = this.mode === 'force';
    this.torqueViz.visible = this.mode === 'torque';
    this.update();
    this.demo.renderer.domElement.setPointerCapture?.(event.pointerId);
  }

  pointerMove(event) {
    if (!this.active) return;
    event.preventDefault();
    event.stopPropagation();
    this.updateRay(event);
    if (this.mode === 'torque') {
      const right = new THREE.Vector3().setFromMatrixColumn(this.demo.camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.demo.camera.matrix, 1);
      const dragX = event.clientX - this.startX;
      const dragY = event.clientY - this.startY;
      const amount = Math.hypot(dragX, dragY);
      if (amount <= TORQUE_CONFIG.dragDeadzonePx) {
        this.torque.set(0, 0, 0);
      } else {
        const scale = ((amount - TORQUE_CONFIG.dragDeadzonePx) / amount) * TORQUE_CONFIG.dragGain;
        this.torque.copy(up.multiplyScalar(dragX * scale)).add(right.multiplyScalar(dragY * scale));
      }
      if (this.torque.length() > TORQUE_CONFIG.dragMax) {
        this.torque.setLength(TORQUE_CONFIG.dragMax);
      }
    } else {
      this.currentWorld.copy(this.raycaster.ray.origin).addScaledVector(this.raycaster.ray.direction, this.grabDistance);
    }
    this.deadline = performance.now() + FORCE_CONFIG.dragDeadlineMs;
  }

  pointerUp(event) {
    if (!this.active) return;
    event.preventDefault();
    event.stopPropagation();
    this.active = false;
    this.bodyId = null;
    this.bodyObject = null;
    this.mode = 'force';
    this.torque.set(0, 0, 0);
    this.demo.controls.enabled = true;
    this.forceViz.visible = false;
    this.torqueViz.visible = false;
    this.demo.renderer.domElement.releasePointerCapture?.(event.pointerId);
  }

  cancel() {
    this.active = false;
    this.bodyId = null;
    this.bodyObject = null;
    this.mode = 'force';
    this.torque.set(0, 0, 0);
    this.demo.controls.enabled = true;
    this.forceViz.visible = false;
    this.torqueViz.visible = false;
  }

  update() {
    if (!this.active || !this.bodyObject) return;
    this.worldHit.copy(this.localHit);
    this.bodyObject.localToWorld(this.worldHit);
    const offset = this.currentWorld.clone().sub(this.worldHit);
    if (this.mode === 'torque') {
      const bodyCenter = new THREE.Vector3();
      this.bodyObject.getWorldPosition(bodyCenter);
      this.forceViz.visible = false;
      setTorqueCubeViz(this.torqueViz, bodyCenter, this.torque);
    } else {
      this.torqueViz.visible = false;
      setForceVectorViz(this.forceViz, this.worldHit, forceArrowVector(offset));
    }
  }
}

function SimpleOrbitControls(camera, domElement) {
  this.camera = camera;
  this.domElement = domElement;
  this.target = new THREE.Vector3();
  this.radius = ORBIT_CONFIG.initialRadius;
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
      const scale = this.radius * ORBIT_CONFIG.panSpeed;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      this.target.addScaledVector(right, -dx * scale);
      this.target.addScaledVector(up, dy * scale);
    } else {
      this.theta -= dx * ORBIT_CONFIG.rotateSpeed;
      this.phi = Math.max(
        ORBIT_CONFIG.minPhi,
        Math.min(Math.PI - ORBIT_CONFIG.maxPhiMargin, this.phi - dy * ORBIT_CONFIG.rotateSpeed),
      );
    }
  };

  const pointerUp = (event) => {
    this.dragging = false;
    domElement.releasePointerCapture?.(event.pointerId);
  };

  const wheel = (event) => {
    event.preventDefault();
    this.radius = Math.max(
      ORBIT_CONFIG.minRadius,
      Math.min(ORBIT_CONFIG.maxRadius, this.radius * Math.exp(event.deltaY * ORBIT_CONFIG.zoomSpeed)),
    );
  };

  domElement.addEventListener('pointerdown', pointerDown);
  domElement.addEventListener('pointermove', pointerMove);
  domElement.addEventListener('pointerup', pointerUp);
  domElement.addEventListener('pointercancel', pointerUp);
  domElement.addEventListener('wheel', wheel, { passive: false });
  domElement.addEventListener('contextmenu', (event) => event.preventDefault());

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

function buildCommandControls(demo) {
  el.commandControls.replaceChildren();
  demo.commandControls = [];
  demo.commandHotkeys = new Set();
  const title = document.createElement('div');
  title.className = 'command-title';
  title.textContent = demo.commandSchema?.title || 'Command';
  el.commandControls.append(title);
  const dims = demo.commandSchema?.dims || [];
  for (let i = 0; i < dims.length; i++) {
    const dim = dims[i];
    const row = document.createElement('label');
    const header = document.createElement('span');
    const label = document.createElement('span');
    label.textContent = dim.unit ? `${dim.label} (${dim.unit})` : dim.label;
    const value = document.createElement('strong');
    header.append(label, value);
    const input = buildCommandInput(demo, dim, i);
    const update = () => {
      demo.command[i] = commandInputValue(input, dim);
      value.textContent = formatCommandValue(dim, demo.command[i]);
    };
    input.addEventListener(dim.type === 'select' ? 'change' : 'input', update);
    if (dim.type === 'toggle') {
      input.addEventListener('change', update);
    }
    update();
    row.append(header, input);
    el.commandControls.append(row);
    demo.commandControls.push({ index: i, dim, input, value });
    for (const code of Object.values(dim.hotkeys || {})) {
      demo.commandHotkeys.add(code);
    }
  }
}

function buildCommandInput(demo, dim, index) {
  if (dim.type === 'select') {
    const select = document.createElement('select');
    for (const option of dim.options || []) {
      const optionEl = document.createElement('option');
      optionEl.value = String(option.value);
      optionEl.textContent = option.label;
      select.append(optionEl);
    }
    select.value = String(demo.command[index] ?? dim.default ?? 0);
    return select;
  }
  if (dim.type === 'toggle') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Number(demo.command[index] ?? dim.default ?? 0) === Number(dim.max);
    return input;
  }
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(dim.min);
  input.max = String(dim.max);
  input.step = String(dim.step || 0.01);
  input.value = String(demo.command[index] ?? dim.default ?? 0);
  return input;
}

function commandInputValue(input, dim) {
  if (dim.type === 'toggle') {
    return input.checked ? Number(dim.max) : Number(dim.min ?? 0);
  }
  return Number(input.value);
}

function updateCommandControls(demo) {
  for (const control of demo.commandControls || []) {
    const value = demo.command[control.index] ?? control.dim.default ?? 0;
    if (control.dim.type === 'toggle') {
      control.input.checked = Number(value) === Number(control.dim.max);
    } else {
      control.input.value = String(value);
    }
    control.value.textContent = formatCommandValue(control.dim, value);
  }
}

function keyCommand(schema, keys) {
  if (!schema) return [];
  const command = defaultCommand(schema);
  for (let i = 0; i < (schema.dims || []).length; i++) {
    const dim = schema.dims[i];
    const hotkeys = dim.hotkeys || {};
    const positive = hotkeys.positive && keys.has(hotkeys.positive);
    const negative = hotkeys.negative && keys.has(hotkeys.negative);
    if (positive && !negative) {
      command[i] = Number(dim.max);
    } else if (negative && !positive) {
      command[i] = Number(dim.min);
    }
  }
  return command;
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
  el.commandHelp.innerHTML = `<b>Command:</b> ${pairs.length ? pairs.join(' · ') : 'use the panel controls'}`;
}

function formatKey(code) {
  if (!code) {
    return '-';
  }
  if (code.startsWith('Key')) {
    return code.slice(3);
  }
  if (code.startsWith('Digit')) {
    return code.slice(5);
  }
  return code.replace(/^Arrow/, '');
}

function formatCommandValue(dim, value) {
  if (dim.type === 'select') {
    const option = (dim.options || []).find((item) => Number(item.value) === Number(value));
    return option ? option.label : String(value);
  }
  if (dim.type === 'toggle') {
    return Number(value) === Number(dim.max) ? 'On' : 'Off';
  }
  return signed(value);
}

function defaultCommand(schema) {
  return (schema?.dims || []).map((dim) => Number(dim.default || 0));
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
  const force = forceDragOffset(offset).multiplyScalar(FORCE_CONFIG.dragGain);
  if (force.length() > FORCE_CONFIG.dragMax) {
    force.setLength(FORCE_CONFIG.dragMax);
  }
  return force;
}

function forceArrowVector(offset) {
  const force = dragForceFromOffset(offset);
  const forceNorm = force.length();
  if (forceNorm <= 1e-5) {
    return new THREE.Vector3();
  }
  return force.setLength((forceNorm / FORCE_CONFIG.dragMax) * FORCE_CONFIG.arrowMaxLength);
}

function contactForceVector(force) {
  const forceNorm = force.length();
  if (forceNorm <= 1e-6) {
    return new THREE.Vector3();
  }
  return force.setLength(Math.min(forceNorm * CONTACT_CONFIG.forceScale, CONTACT_CONFIG.forceMaxLength));
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

function createSimulationWrapper(mujoco, model, data) {
  const force = new Float64Array(3);
  const torque = new Float64Array(3);
  const point = new Float64Array(3);
  return {
    get qpos() { return data.qpos; },
    get qvel() { return data.qvel; },
    get ctrl() { return data.ctrl; },
    get qfrc_applied() { return data.qfrc_applied; },
    get xpos() { return data.xpos; },
    get xquat() { return data.xquat; },
    step() { mujoco.mj_step(model, data); },
    resetData() { mujoco.mj_resetData(model, data); },
    forward() { mujoco.mj_forward(model, data); },
    applyForce(fx, fy, fz, tx, ty, tz, px, py, pz, bodyId) {
      force[0] = fx; force[1] = fy; force[2] = fz;
      torque[0] = tx; torque[1] = ty; torque[2] = tz;
      point[0] = px; point[1] = py; point[2] = pz;
      mujoco.mj_applyFT(model, data, force, torque, point, bodyId, data.qfrc_applied);
    },
  };
}

function meshGeometry(model, meshId, cache) {
  if (cache.has(meshId)) return cache.get(meshId);
  const vertStart = model.mesh_vertadr[meshId];
  const vertEnd = vertStart + model.mesh_vertnum[meshId];
  const faceStart = model.mesh_faceadr[meshId];
  const faceEnd = faceStart + model.mesh_facenum[meshId];
  const positions = [];
  const normals = [];
  for (let i = vertStart * 3; i < vertEnd * 3; i += 3) {
    positions.push(model.mesh_vert[i], model.mesh_vert[i + 2], -model.mesh_vert[i + 1]);
    normals.push(model.mesh_normal[i], model.mesh_normal[i + 2], -model.mesh_normal[i + 1]);
  }
  const indices = Array.from(model.mesh_face.subarray(faceStart * 3, faceEnd * 3));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  cache.set(meshId, geometry);
  return geometry;
}

function materialForGeom(model, geomId) {
  const matId = model.geom_matid[geomId];
  let rgba = [
    model.geom_rgba[geomId * 4],
    model.geom_rgba[geomId * 4 + 1],
    model.geom_rgba[geomId * 4 + 2],
    model.geom_rgba[geomId * 4 + 3],
  ];
  if (matId >= 0) {
    rgba = [
      model.mat_rgba[matId * 4],
      model.mat_rgba[matId * 4 + 1],
      model.mat_rgba[matId * 4 + 2],
      model.mat_rgba[matId * 4 + 3],
    ];
  }
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(rgba[0], rgba[1], rgba[2]),
    transparent: rgba[3] < 1,
    opacity: rgba[3],
    roughness: GEOM_MATERIAL_CONFIG.roughness,
    metalness: GEOM_MATERIAL_CONFIG.metalness,
    clearcoat: GEOM_MATERIAL_CONFIG.clearcoat,
  });
}

function floorMaterial() {
  const canvas = document.createElement('canvas');
  canvas.width = FLOOR_CONFIG.canvasSize;
  canvas.height = FLOOR_CONFIG.canvasSize;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = FLOOR_CONFIG.baseColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = FLOOR_CONFIG.lineColor;
  ctx.lineWidth = 2;
  for (let i = 0; i <= FLOOR_CONFIG.canvasSize; i += FLOOR_CONFIG.gridStep) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, FLOOR_CONFIG.canvasSize);
    ctx.moveTo(0, i);
    ctx.lineTo(FLOOR_CONFIG.canvasSize, i);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(...FLOOR_CONFIG.repeat);
  return new THREE.MeshStandardMaterial({ color: 0xffffff, map: texture, roughness: FLOOR_CONFIG.roughness });
}

function readNames(model, kind) {
  const adrName = `name_${kind}adr`;
  const countName = `n${kind}`;
  const names = [];
  const bytes = new Uint8Array(model.names);
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < model[countName]; i++) {
    const start = model[adrName][i];
    let end = start;
    while (end < bytes.length && bytes[end] !== 0) end++;
    names.push(decoder.decode(bytes.subarray(start, end)));
  }
  return names;
}

function getPosition(buffer, index, target) {
  return target.set(buffer[index * 3], buffer[index * 3 + 2], -buffer[index * 3 + 1]);
}

function getQuaternion(buffer, index, target) {
  return target.set(-buffer[index * 4 + 1], -buffer[index * 4 + 3], buffer[index * 4 + 2], -buffer[index * 4]);
}

function threeToMj(value) {
  return value.set(value.x, -value.z, value.y);
}

function gather(buffer, indices) {
  return indices.map((idx) => buffer[idx]);
}

function quatToBodyGravity(quat) {
  const [w, x, y, z] = normalizeQuat(quat);
  return [
    2.0 * (y * w - x * z),
    -2.0 * (y * z + x * w),
    2.0 * (x * x + y * y) - 1.0,
  ];
}

function normalizeQuat(quat) {
  const [w, x, y, z] = quat;
  const norm = Math.hypot(w, x, y, z) || 1;
  return [w / norm, x / norm, y / norm, z / norm];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function signed(value) {
  return `${value >= 0 ? '+' : ''}${Number(value).toFixed(2)}`;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  try {
    const manifest = await fetchJson(MANIFEST_URL);
    el.loading.textContent = 'Loading MuJoCo WASM';
    const mujoco = await loadMujoco();
    el.loading.textContent = 'Loading robot and policy';
    const demo = new RuntimeDemo(mujoco, manifest);
    window.demo = demo;
    await demo.init();
    el.loading.hidden = true;
    el.connection.textContent = 'Ready';
    el.contacts.disabled = false;
    el.run.addEventListener('click', () => {
      demo.running = !demo.running;
    });
    el.reset.addEventListener('click', () => demo.reset());
    el.viewHome.addEventListener('click', () => demo.resetView());
    el.follow.addEventListener('click', () => {
      demo.follow = !demo.follow;
      el.follow.setAttribute('aria-pressed', String(demo.follow));
    });
    el.contacts.addEventListener('click', () => {
      demo.showContacts = !demo.showContacts;
      el.contacts.setAttribute('aria-pressed', String(demo.showContacts));
      if (!demo.showContacts) {
        demo.hideUnusedContacts(0);
      }
    });
    el.drag.addEventListener('click', () => {
      demo.dragEnabled = !demo.dragEnabled;
      el.drag.setAttribute('aria-pressed', String(demo.dragEnabled));
    });
    demo.running = true;
  } catch (error) {
    console.error(error);
    el.loading.hidden = false;
    el.loading.textContent = `Failed to load runtime: ${error.message || error}`;
    el.connection.textContent = 'Error';
  }
}

main();
