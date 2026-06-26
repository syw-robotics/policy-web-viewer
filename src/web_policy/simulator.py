from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import mujoco
import numpy as np

from unitree_deploy.config.defaults import (
    GYRO_SENSOR_NAMES,
    RENDER_HZ,
    SIM_HZ,
)
from unitree_deploy.obs.observation import ObservationContext
from unitree_deploy.robot_model.robot_config import DEFAULT_TERRAIN, RobotModel, load_robot_model
from unitree_deploy.runtime.multi_ckpt import PolicyManager
from unitree_deploy.utils.viewer_backend import ViewerCameraConfig, load_viewer_camera_config
from web_policy.command_schema import (
    CommandSchema,
    check_command_schema_compatibility,
    load_command_schema,
)


def _resolve_existing_path(path: Path) -> Path:
    expanded = path.expanduser()
    if expanded.is_absolute():
        return expanded.resolve()

    for base in (Path.cwd(), *Path.cwd().parents, Path(__file__).resolve(), *Path(__file__).resolve().parents):
        candidate = base / expanded
        if candidate.exists():
            return candidate.resolve()
    return expanded.resolve()


@dataclass(frozen=True)
class RuntimeConfig:
    ckpt_dir: Path
    robot: RobotModel
    multi_ckpt: Path | None = None
    sim_hz: int = SIM_HZ
    render_hz: int = RENDER_HZ
    auto_start: bool = True


class OnlineDemoSimulator:
    """Direct MuJoCo + ONNX policy loop for the browser demo.

    This intentionally bypasses Unitree DDS. The runtime state is read straight
    from MuJoCo and converted into the same ObservationContext used by BasePolicy.
    """

    def __init__(self, config: RuntimeConfig) -> None:
        self.config = config
        self.policy_manager = PolicyManager.load(config.ckpt_dir, config.multi_ckpt)
        self.profile = self.policy_manager.active
        self.command_schemas = self._load_command_schemas()
        self.command_schema = self.command_schemas[self.active_profile_name]
        self.model = mujoco.MjModel.from_xml_path(str(config.robot.xml_path))
        self.model.opt.timestep = 1.0 / float(config.sim_hz)
        self.data = mujoco.MjData(self.model)
        self._scene_cache: dict | None = None
        self.camera = load_viewer_camera_config(config.robot)
        self.track_body_id = self._track_body_id(self.camera)

        self.num_motor = int(self.model.nu)
        self.actuator_joint_ids = self._actuator_joint_ids()
        self.actuator_joint_names = self._joint_names(self.actuator_joint_ids)
        self.motor_qposadr = self.model.jnt_qposadr[self.actuator_joint_ids].astype(np.int64)
        self.motor_dofadr = self.model.jnt_dofadr[self.actuator_joint_ids].astype(np.int64)
        self.ctrl_lower = self.model.actuator_ctrlrange[:, 0].copy()
        self.ctrl_upper = self.model.actuator_ctrlrange[:, 1].copy()

        self.obs_qposadr, self.obs_dofadr = self._joint_addresses(self.profile.obs_joint_order)
        self.sdk_to_actuator = self._sdk_to_actuator_indices()
        self.controlled = self.sdk_to_actuator >= 0
        self.kp = np.zeros(self.num_motor, dtype=np.float64)
        self.kd = np.zeros(self.num_motor, dtype=np.float64)
        self.target_q = np.zeros(self.num_motor, dtype=np.float64)
        self.ctrl = np.zeros(self.num_motor, dtype=np.float64)
        self.command_min = self.command_schema.min_vector()
        self.command_max = self.command_schema.max_vector()
        self.command = self.command_schema.default_vector()
        self.drag_body_id: int | None = None
        self.drag_point = np.zeros(3, dtype=np.float64)
        self.drag_force = np.zeros(3, dtype=np.float64)
        self.drag_torque = np.zeros(3, dtype=np.float64)
        self.drag_deadline = 0.0

        self.gyro_sensor = self._sensor_slice(GYRO_SENSOR_NAMES, mujoco.mjtSensor.mjSENS_GYRO)
        self.initial_qpos = self._initial_qpos()

        self.lock = threading.RLock()
        self.alive = False
        self.running = bool(config.auto_start)
        self.thread: threading.Thread | None = None
        self.sim_steps = 0
        self.last_rtf_steps = 0
        self.last_policy_t = -math.inf
        self.last_wall_t = time.perf_counter()
        self.real_time_factor = 0.0

        self.reset()

    @property
    def active_profile_name(self) -> str:
        return self.policy_manager.active_name

    def _load_command_schemas(self) -> dict[str, CommandSchema]:
        schemas = {
            name: load_command_schema(profile.policy_yaml_path, profile.policy)
            for name, profile in self.policy_manager.profiles.items()
        }
        check_command_schema_compatibility(schemas)
        return schemas

    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.alive = True
        self.thread = threading.Thread(target=self._loop, name="web-policy-sim", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.alive = False
        if self.thread:
            self.thread.join(timeout=2.0)

    def set_running(self, running: bool) -> None:
        with self.lock:
            self.running = bool(running)
            self.profile.policy.reset()
            self.last_policy_t = -math.inf

    def set_command(self, command) -> None:
        values = np.asarray(command, dtype=np.float64).reshape(-1)
        if values.size != self.command.size:
            raise ValueError(f"expected {self.command.size} command values, got {values.size}")
        with self.lock:
            np.clip(values, self.command_min, self.command_max, out=self.command)

    def set_drag_force(self, payload: dict) -> None:
        active = bool(payload.get("active", False))
        with self.lock:
            if not active:
                self.drag_body_id = None
                self.drag_force.fill(0.0)
                self.drag_torque.fill(0.0)
                return

            body_id = int(payload["body_id"])
            if body_id <= 0 or body_id >= self.model.nbody:
                raise ValueError(f"invalid drag body_id: {body_id}")
            point = np.asarray(payload["point"], dtype=np.float64).reshape(3)
            force = np.asarray(payload["force"], dtype=np.float64).reshape(3)
            torque = np.asarray(payload.get("torque", [0.0, 0.0, 0.0]), dtype=np.float64).reshape(3)
            norm = float(np.linalg.norm(force))
            if norm > 120.0:
                force *= 120.0 / norm
            torque_norm = float(np.linalg.norm(torque))
            if torque_norm > 80.0:
                torque *= 80.0 / torque_norm

            self.drag_body_id = body_id
            self.drag_point[:] = point
            self.drag_force[:] = force
            self.drag_torque[:] = torque
            self.drag_deadline = time.perf_counter() + 0.15

    def reset(self) -> None:
        with self.lock:
            mujoco.mj_resetData(self.model, self.data)
            self.data.qpos[:] = self.initial_qpos
            self.data.qvel[:] = 0.0
            self.data.ctrl[:] = 0.0
            mujoco.mj_forward(self.model, self.data)
            self.profile.policy.reset()
            self.sim_steps = 0
            self.last_rtf_steps = 0
            self.last_policy_t = -math.inf
            self.last_wall_t = time.perf_counter()
            self.drag_body_id = None
            self.drag_force.fill(0.0)
            self.drag_torque.fill(0.0)

    def switch_next_policy(self) -> str:
        if not self.policy_manager.switch.enabled:
            return self.active_profile_name
        with self.lock:
            self.profile = self.policy_manager.switch_next()
            self.command_schema = self.command_schemas[self.active_profile_name]
            self.command_min = self.command_schema.min_vector()
            self.command_max = self.command_schema.max_vector()
            self.profile.policy.reset()
            self.last_policy_t = -math.inf
            np.clip(self.command, self.command_min, self.command_max, out=self.command)
            return self.active_profile_name

    def status(self) -> dict:
        with self.lock:
            return {
                "running": self.running,
                "robot": self.config.robot.name,
                "terrain": self.config.robot.terrain,
                "policy": self.active_profile_name,
                "policies": list(self.policy_manager.profiles),
                "switch_enabled": self.policy_manager.switch.enabled,
                "time": round(float(self.data.time), 3),
                "height": round(float(self.data.qpos[2]), 3) if self.data.qpos.size >= 3 else 0.0,
                "command": [round(float(v), 3) for v in self.command],
                "command_schema": self.command_schema.to_json(),
                "rtf": round(float(self.real_time_factor), 2),
            }

    def scene_description(self) -> dict:
        with self.lock:
            if self._scene_cache is not None:
                return self._scene_cache
            mesh_ids = sorted(
                {
                    int(self.model.geom_dataid[geom_id])
                    for geom_id in range(self.model.ngeom)
                    if int(self.model.geom_type[geom_id]) == int(mujoco.mjtGeom.mjGEOM_MESH)
                    and int(self.model.geom_group[geom_id]) < 3
                    and int(self.model.geom_dataid[geom_id]) >= 0
                }
            )
            meshes = {str(mesh_id): self._mesh_description(mesh_id) for mesh_id in mesh_ids}
            self._scene_cache = {
                "robot": self.config.robot.name,
                "terrain": self.config.robot.terrain,
                "camera": {
                    "lookat": list(self.camera.lookat),
                    "distance": self.camera.distance,
                    "elevation": self.camera.elevation,
                    "azimuth": self.camera.azimuth,
                    "track_body": self.camera.track_body,
                },
                "command_schema": self.command_schema.to_json(),
                "bodies": [
                    {
                        "id": body_id,
                        "name": self._body_name(body_id),
                    }
                    for body_id in range(self.model.nbody)
                ],
                "geoms": [
                    self._geom_description(geom_id)
                    for geom_id in range(self.model.ngeom)
                    if int(self.model.geom_group[geom_id]) < 3
                ],
                "meshes": meshes,
            }
            return self._scene_cache

    def frame(self, *, include_contacts: bool = False) -> dict:
        with self.lock:
            frame = {
                "status": self.status(),
                "bodies": [
                    {
                        "id": body_id,
                        "pos": self.data.xpos[body_id].tolist(),
                        "quat": self.data.xquat[body_id].tolist(),
                    }
                    for body_id in range(self.model.nbody)
                ],
            }
            if include_contacts:
                frame["contacts"] = self._contact_debug_locked()
            return frame

    def _loop(self) -> None:
        dt = 1.0 / float(self.config.sim_hz)
        next_t = time.perf_counter()
        while self.alive:
            with self.lock:
                if self.running:
                    self._step_locked()
            next_t += dt
            sleep_s = next_t - time.perf_counter()
            if sleep_s > 0.0:
                time.sleep(sleep_s)
            else:
                next_t = time.perf_counter()

    def _step_locked(self) -> None:
        if self.data.time - self.last_policy_t >= self.profile.policy.policy_step_dt - 1e-9:
            self._update_policy_target_locked()
            self.last_policy_t = float(self.data.time)

        q = self.data.qpos[self.motor_qposadr]
        dq = self.data.qvel[self.motor_dofadr]
        self.ctrl[:] = self.kp * (self.target_q - q) - self.kd * dq
        self.ctrl[~self.controlled] = 0.0
        np.clip(self.ctrl, self.ctrl_lower, self.ctrl_upper, out=self.ctrl)
        self.data.ctrl[:] = self.ctrl
        self.data.qfrc_applied[:] = 0.0
        self._apply_drag_force_locked()
        mujoco.mj_step(self.model, self.data)
        self.sim_steps += 1

        now = time.perf_counter()
        elapsed = now - self.last_wall_t
        if elapsed >= 1.0:
            step_delta = self.sim_steps - self.last_rtf_steps
            self.real_time_factor = step_delta / (float(self.config.sim_hz) * elapsed)
            self.last_rtf_steps = self.sim_steps
            self.last_wall_t = now

    def _update_policy_target_locked(self) -> None:
        context = ObservationContext(
            q=self.data.qpos[self.obs_qposadr].copy(),
            dq=self.data.qvel[self.obs_dofadr].copy(),
            quat=self.data.qpos[3:7].copy(),
            gyro=self._gyro_locked(),
            command=self.command.copy(),
        )
        target_obs = self.profile.policy.compute_target_q(context)
        target_sdk = target_obs[self.profile.obs_to_sdk]
        self.target_q[:] = self.data.qpos[self.motor_qposadr]
        self.kp.fill(0.0)
        self.kd.fill(0.0)
        for actuator_i, sdk_i in enumerate(self.sdk_to_actuator):
            if sdk_i < 0:
                continue
            self.target_q[actuator_i] = target_sdk[sdk_i]
            self.kp[actuator_i] = self.profile.kp_policy[sdk_i]
            self.kd[actuator_i] = self.profile.kd_policy[sdk_i]

    def _apply_drag_force_locked(self) -> None:
        if self.drag_body_id is None:
            return
        if time.perf_counter() > self.drag_deadline:
            self.drag_body_id = None
            self.drag_force.fill(0.0)
            self.drag_torque.fill(0.0)
            return
        application_point = self.drag_point
        if np.linalg.norm(self.drag_torque) > 1e-9:
            application_point = self.data.xipos[self.drag_body_id]
        mujoco.mj_applyFT(
            self.model,
            self.data,
            self.drag_force,
            self.drag_torque,
            application_point,
            self.drag_body_id,
            self.data.qfrc_applied,
        )

    def _contact_debug_locked(self) -> list[dict]:
        contacts = []
        force = np.zeros(6, dtype=np.float64)
        for contact_i in range(int(self.data.ncon)):
            contact = self.data.contact[contact_i]
            mujoco.mj_contactForce(self.model, self.data, contact_i, force)
            frame = contact.frame.reshape(3, 3)
            force_world = frame.T @ force[:3]
            contacts.append(
                {
                    "pos": contact.pos.tolist(),
                    "force": force_world.tolist(),
                    "dist": float(contact.dist),
                    "geom1": int(contact.geom1),
                    "geom2": int(contact.geom2),
                }
            )
        return contacts

    def _gyro_locked(self) -> np.ndarray:
        if self.gyro_sensor is None:
            return self.data.qvel[3:6].copy()
        adr, dim = self.gyro_sensor
        if dim < 3:
            return self.data.qvel[3:6].copy()
        return self.data.sensordata[adr : adr + 3].copy()

    def _initial_qpos(self) -> np.ndarray:
        home_id = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_KEY, "home")
        if home_id < 0 and self.model.nkey == 1:
            home_id = 0
        if home_id >= 0:
            return self.model.key_qpos[home_id].copy()
        qpos = np.zeros(self.model.nq, dtype=np.float64)
        qpos[:7] = np.array([0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], dtype=np.float64)
        return qpos

    def _actuator_joint_ids(self) -> np.ndarray:
        joint_ids = np.zeros(self.num_motor, dtype=np.int32)
        for actuator_i in range(self.num_motor):
            trn_type = int(self.model.actuator_trntype[actuator_i])
            if trn_type != int(mujoco.mjtTrn.mjTRN_JOINT):
                raise ValueError(f"actuator {actuator_i} must use joint transmission")
            joint_id = int(self.model.actuator_trnid[actuator_i, 0])
            joint_type = int(self.model.jnt_type[joint_id])
            if joint_type not in (int(mujoco.mjtJoint.mjJNT_HINGE), int(mujoco.mjtJoint.mjJNT_SLIDE)):
                name = mujoco.mj_id2name(self.model, mujoco.mjtObj.mjOBJ_JOINT, joint_id)
                raise ValueError(f"actuated joint {name or joint_id!r} must be 1-DoF")
            joint_ids[actuator_i] = joint_id
        return joint_ids

    def _joint_names(self, joint_ids: np.ndarray) -> list[str]:
        names = []
        for joint_id in joint_ids:
            name = mujoco.mj_id2name(self.model, mujoco.mjtObj.mjOBJ_JOINT, int(joint_id))
            if not name:
                raise ValueError(f"joint {int(joint_id)} has no name")
            names.append(name)
        return names

    def _body_name(self, body_id: int) -> str:
        name = mujoco.mj_id2name(self.model, mujoco.mjtObj.mjOBJ_BODY, int(body_id))
        return name or f"body_{body_id}"

    def _geom_description(self, geom_id: int) -> dict:
        mat_id = int(self.model.geom_matid[geom_id])
        if 0 <= mat_id < self.model.nmat:
            rgba = self.model.mat_rgba[mat_id].tolist()
        else:
            rgba = self.model.geom_rgba[geom_id].tolist()
        return {
            "id": geom_id,
            "body_id": int(self.model.geom_bodyid[geom_id]),
            "type": int(self.model.geom_type[geom_id]),
            "mesh_id": int(self.model.geom_dataid[geom_id]),
            "size": self.model.geom_size[geom_id].tolist(),
            "pos": self.model.geom_pos[geom_id].tolist(),
            "quat": self.model.geom_quat[geom_id].tolist(),
            "rgba": rgba,
        }

    def _mesh_description(self, mesh_id: int) -> dict:
        vert_start = int(self.model.mesh_vertadr[mesh_id])
        vert_end = vert_start + int(self.model.mesh_vertnum[mesh_id])
        face_start = int(self.model.mesh_faceadr[mesh_id])
        face_end = face_start + int(self.model.mesh_facenum[mesh_id])
        vertices = np.round(self.model.mesh_vert[vert_start:vert_end], 6)
        normals = np.round(self.model.mesh_normal[vert_start:vert_end], 6)
        faces = self.model.mesh_face[face_start:face_end]
        return {
            "id": mesh_id,
            "vertices": vertices.reshape(-1).tolist(),
            "normals": normals.reshape(-1).tolist(),
            "faces": faces.reshape(-1).tolist(),
        }

    def _joint_addresses(self, joint_order: list[str]) -> tuple[np.ndarray, np.ndarray]:
        qposadr = np.zeros(len(joint_order), dtype=np.int64)
        dofadr = np.zeros(len(joint_order), dtype=np.int64)
        for i, name in enumerate(joint_order):
            joint_id = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, name)
            if joint_id < 0:
                raise ValueError(f"policy joint {name!r} not found in MuJoCo model")
            qposadr[i] = int(self.model.jnt_qposadr[joint_id])
            dofadr[i] = int(self.model.jnt_dofadr[joint_id])
        return qposadr, dofadr

    def _sdk_to_actuator_indices(self) -> np.ndarray:
        sdk_index = {name: i for i, name in enumerate(self.profile.sdk_joint_order)}
        return np.asarray([sdk_index.get(name, -1) for name in self.actuator_joint_names], dtype=np.int64)

    def _sensor_slice(self, names: tuple[str, ...], sensor_type: mujoco.mjtSensor) -> tuple[int, int] | None:
        for name in names:
            sid = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_SENSOR, name)
            if sid >= 0:
                return int(self.model.sensor_adr[sid]), int(self.model.sensor_dim[sid])
        for sid in range(self.model.nsensor):
            if int(self.model.sensor_type[sid]) == int(sensor_type):
                return int(self.model.sensor_adr[sid]), int(self.model.sensor_dim[sid])
        return None

    def _track_body_id(self, camera: ViewerCameraConfig) -> int | None:
        if not camera.track_body:
            return None
        body_id = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_BODY, camera.track_body)
        if body_id < 0:
            raise ValueError(f"viewer.camera.track_body not found: {camera.track_body}")
        return int(body_id)

    def _render_camera(self) -> mujoco.MjvCamera:
        camera = mujoco.MjvCamera()
        camera.type = mujoco.mjtCamera.mjCAMERA_FREE
        camera.lookat[:] = self.camera.lookat
        if self.track_body_id is not None:
            camera.lookat[:] = self.data.xpos[self.track_body_id] + self.camera.track_offset
        camera.distance = self.camera.distance
        camera.elevation = self.camera.elevation
        camera.azimuth = self.camera.azimuth
        return camera


def build_config(
    *,
    ckpt: Path | None,
    multi_ckpt: Path | None,
    robot: str | None,
    model_xml: Path | None,
    terrain: str | Path = DEFAULT_TERRAIN,
    auto_start: bool = True,
) -> RuntimeConfig:
    if ckpt is None and multi_ckpt is None:
        raise ValueError("one of ckpt or multi_ckpt is required")
    resolved_multi_ckpt = _resolve_existing_path(multi_ckpt) if multi_ckpt else None
    ckpt_dir = _resolve_existing_path(ckpt) if ckpt else resolved_multi_ckpt.parent
    robot_name = robot or "g1"
    robot_model = load_robot_model(robot_name, model_xml=model_xml, terrain=terrain)
    return RuntimeConfig(
        ckpt_dir=ckpt_dir,
        robot=robot_model,
        multi_ckpt=resolved_multi_ckpt,
        auto_start=auto_start,
    )
