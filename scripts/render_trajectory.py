from __future__ import annotations

import argparse
import json
import math
import os
import site
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import bpy
import mathutils
import numpy as np


DEFAULT_GEOM_GROUPS = {0, 1, 2}
DEFAULT_BACKGROUND = "#161a1d"
DEFAULT_TEMPLATE_DELETE_COLLECTIONS = "army,robots,robot,pushing_robot,axes,axes.001"
DEFAULT_TEMPLATE_DELETE_OBJECTS = "push_robot,pushing_robot"
DEFAULT_TEMPLATE_LIGHT_OFFSETS = {
    "Light": (-2.6, -3.2, 4.8),
    "Light.001": (2.6, 1.8, 3.2),
    "rim_line": (2.2, -3.4, 2.4),
    "back_edge": (2.2, -3.4, 2.4),
    "ceiling_wash": (0.2, 0.0, 4.3),
}


@dataclass(frozen=True)
class StageLayout:
    center: mathutils.Vector
    size: float


def main() -> None:
    args = parse_args()

    trajectory_path = args.trajectory.expanduser().resolve()
    metadata_path = (args.metadata or trajectory_path.with_name("metadata.json")).expanduser().resolve()
    output_path = resolve_output_path(args)
    using_template = args.template_blend is not None
    if using_template:
        load_template_scene(args)
        scale_template_lights(args.template_light_scale)

    data = np.load(trajectory_path)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    scene_desc = load_scene_description(args, metadata, metadata_path, trajectory_path)

    validate_trajectory(data, metadata, scene_desc)
    if not using_template:
        clear_scene()
    display_body_pos = transform_body_positions(args, scene_desc, data["body_pos"], using_template=using_template)
    configure_scene(args, data, metadata, using_template=using_template)

    materials = build_materials(scene_desc, style=args.robot_material_style)
    body_empties = create_body_empties(scene_desc)
    create_scene_geoms(scene_desc, body_empties, materials, parse_geom_groups(args.geom_groups))
    if not using_template:
        stage = add_stage(args, scene_desc, display_body_pos)
        add_lighting(args, stage)
    camera = create_camera(args, using_template=using_template)
    focus_object = template_focus_object() if using_template else None
    animate_bodies(body_empties, display_body_pos, data["body_quat"], fps=args.fps)
    animate_follow_camera(
        camera,
        scene_desc,
        display_body_pos,
        args.camera_target_body,
        args.camera_offset,
        args.camera_lookat_offset,
        focus_object=focus_object,
    )
    if using_template and not args.no_follow_lights:
        animate_follow_lights(args, scene_desc, display_body_pos)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(output_path))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import a unitree-deploy trajectory into a Blender scene.")
    parser.add_argument("--trajectory", type=Path, required=True, help="Path to trajectory.npz.")
    parser.add_argument("--metadata", type=Path, help="Path to metadata.json. Defaults to trajectory sibling.")
    parser.add_argument("--scene-json", type=Path, help="Pre-exported MuJoCo visual geometry JSON.")
    parser.add_argument("--template-blend", type=Path, help="Optional preset .blend scene to keep lights, camera, floor, and render settings.")
    parser.add_argument("--template-light-scale", type=float, default=1.0, help="Scale existing template light energy.")
    parser.add_argument("--follow-light-names", default="", help="Comma-separated template light names to follow the robot. Empty means all nonzero template lights.")
    parser.add_argument("--no-follow-lights", action="store_true", help="Do not animate template lights with the robot.")
    parser.add_argument("--no-template-center-trajectory", action="store_true", help="Keep recorded world XY instead of moving the first target-body pose onto the template camera target.")
    parser.add_argument(
        "--template-delete-collections",
        default=DEFAULT_TEMPLATE_DELETE_COLLECTIONS,
        help="Comma-separated template collections to delete before importing the trajectory.",
    )
    parser.add_argument(
        "--template-delete-objects",
        default=DEFAULT_TEMPLATE_DELETE_OBJECTS,
        help="Comma-separated template root objects to delete before importing the trajectory.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="Output .blend name template. A timestamp is appended automatically before the suffix.",
    )
    parser.add_argument(
        "--pythonpath",
        type=Path,
        action="append",
        default=[],
        help="Extra Python package path to add before importing mujoco. Can be repeated.",
    )
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--resolution", type=int, nargs=2, default=(1920, 1080), metavar=("WIDTH", "HEIGHT"))
    parser.add_argument("--samples", type=int, default=64, help="Render samples for Cycles.")
    parser.add_argument("--engine", choices=("auto", "eevee", "cycles"), default="eevee")
    parser.add_argument("--freestyle", choices=("off", "on", "template"), default="off")
    parser.add_argument("--robot-material-style", choices=("paper", "mujoco"), default="paper")
    parser.add_argument("--geom-groups", default="0,1,2", help="Comma-separated MuJoCo geom groups to render.")
    parser.add_argument("--camera-target-body", default="pelvis")
    parser.add_argument("--camera-offset", type=float, nargs=3, default=(-4.0, -3.0, 1.35))
    parser.add_argument("--camera-lookat-offset", type=float, nargs=3, default=(0.0, 0.0, 0.55))
    parser.add_argument("--focal-length", type=float, default=48.0)
    parser.add_argument("--floor-size", type=float, default=36.0, help="Minimum stage size in meters.")
    parser.add_argument("--stage-margin", type=float, default=8.0, help="Extra floor margin around the recorded path.")
    parser.add_argument("--grid-spacing", type=float, default=0.5)
    parser.add_argument("--grid-major-every", type=int, default=4)
    parser.add_argument("--grid-line-width", type=float, default=0.012)
    parser.add_argument("--no-grid", action="store_true")
    parser.add_argument("--background", help=f"World background color. Defaults to {DEFAULT_BACKGROUND} without a template, and keeps the template world when omitted.")
    parser.add_argument("--floor-color", default="#2d3330")
    parser.add_argument("--shadow-softness", type=float, default=4.0)
    return parser.parse_args(argv_after_double_dash())


def resolve_output_path(args: argparse.Namespace) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    template_name = args.template_blend.expanduser().stem if args.template_blend is not None else None
    output_path = timestamped_path(args.out.expanduser().resolve(), stamp, template_name=template_name)
    if output_path.suffix.lower() != ".blend":
        raise ValueError(f"--out must end with .blend, got {output_path}")
    print(f"[render_trajectory] blend output -> {output_path}", flush=True)
    return output_path


def timestamped_path(path: Path, stamp: str, *, template_name: str | None = None) -> Path:
    suffix = f"-{template_name}-{stamp}" if template_name else f"-{stamp}"
    if path.suffix:
        candidate = path.with_name(f"{path.stem}{suffix}{path.suffix}")
    else:
        candidate = path / (f"{template_name}-{stamp}" if template_name else stamp)
    return unique_path(candidate)


def unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    if path.suffix:
        for i in range(1, 1000):
            candidate = path.with_name(f"{path.stem}-{i:03d}{path.suffix}")
            if not candidate.exists():
                return candidate
    else:
        for i in range(1, 1000):
            candidate = path.with_name(f"{path.name}-{i:03d}")
            if not candidate.exists():
                return candidate
    raise FileExistsError(f"could not create a unique output path near {path}")


def configure_python_paths(args: argparse.Namespace) -> None:
    paths = []
    env_path = os.environ.get("BLENDER_PYTHONPATH")
    if env_path:
        paths.extend(Path(part) for part in env_path.split(os.pathsep) if part)
    paths.extend(args.pythonpath)

    conda_prefix = os.environ.get("CONDA_PREFIX")
    if conda_prefix:
        conda_site = (
            Path(conda_prefix)
            / "lib"
            / f"python{sys.version_info.major}.{sys.version_info.minor}"
            / "site-packages"
        )
        if conda_site.exists():
            paths.append(conda_site)

    for path in paths:
        resolved = path.expanduser().resolve()
        if resolved.exists():
            site.addsitedir(str(resolved))


def import_mujoco():
    try:
        import mujoco
    except ImportError as exc:
        searched = "\n  ".join(sys.path)
        raise SystemExit(
            "Blender Python cannot import mujoco.\n\n"
            "Fix options:\n"
            "  1. Install mujoco into Blender's Python.\n"
            "  2. Pass --pythonpath /path/to/site-packages after the script's -- separator.\n"
            "  3. Set BLENDER_PYTHONPATH=/path/to/site-packages before launching Blender.\n\n"
            f"Blender Python: {sys.executable}\n"
            f"Python version: {sys.version.split()[0]}\n"
            f"Current search path:\n  {searched}"
        ) from exc
    return mujoco


def argv_after_double_dash() -> list[str]:
    if "--" not in sys.argv:
        return []
    return sys.argv[sys.argv.index("--") + 1 :]


def load_scene_description(
    args: argparse.Namespace,
    metadata: dict,
    metadata_path: Path,
    trajectory_path: Path,
) -> dict:
    scene_path = args.scene_json.expanduser().resolve() if args.scene_json else trajectory_path.with_name("scene.json")
    if scene_path.exists():
        return json.loads(scene_path.read_text(encoding="utf-8"))

    configure_python_paths(args)
    mujoco = import_mujoco()
    model = mujoco.MjModel.from_xml_path(str(resolve_model_xml(metadata, metadata_path)))
    return export_scene_from_mujoco(mujoco, model, metadata)


def resolve_model_xml(metadata: dict, metadata_path: Path) -> Path:
    value = metadata.get("model_xml")
    if not value:
        raise ValueError("metadata.json is missing 'model_xml'")
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = (metadata_path.parent / path).resolve()
    if not path.exists():
        raise FileNotFoundError(f"MuJoCo model XML not found: {path}")
    return path


def export_scene_from_mujoco(mujoco, model, metadata: dict) -> dict:
    mesh_ids = sorted(
        {
            int(model.geom_dataid[geom_id])
            for geom_id in range(int(model.ngeom))
            if int(model.geom_type[geom_id]) == int(mujoco.mjtGeom.mjGEOM_MESH)
            and int(model.geom_dataid[geom_id]) >= 0
        }
    )
    return {
        "format": "policy-web-viewer-blender-scene-v1",
        "robot": metadata.get("robot"),
        "terrain": metadata.get("terrain"),
        "bodies": [
            {
                "id": body_id,
                "name": mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, body_id) or f"body_{body_id}",
            }
            for body_id in range(int(model.nbody))
        ],
        "geoms": [mujoco_geom_payload(mujoco, model, geom_id) for geom_id in range(int(model.ngeom))],
        "meshes": {str(mesh_id): mujoco_mesh_payload(model, mesh_id) for mesh_id in mesh_ids},
    }


def mujoco_geom_payload(mujoco, model, geom_id: int) -> dict:
    geom_type = int(model.geom_type[geom_id])
    return {
        "id": geom_id,
        "name": mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, geom_id) or f"geom_{geom_id}",
        "body_id": int(model.geom_bodyid[geom_id]),
        "group": int(model.geom_group[geom_id]),
        "type": mujoco.mjtGeom(geom_type).name.removeprefix("mjGEOM_").lower(),
        "mesh_id": int(model.geom_dataid[geom_id]),
        "size": np.asarray(model.geom_size[geom_id], dtype=np.float64).tolist(),
        "pos": np.asarray(model.geom_pos[geom_id], dtype=np.float64).tolist(),
        "quat": np.asarray(model.geom_quat[geom_id], dtype=np.float64).tolist(),
        "rgba": mujoco_geom_rgba(model, geom_id).tolist(),
    }


def mujoco_mesh_payload(model, mesh_id: int) -> dict:
    vert_adr = int(model.mesh_vertadr[mesh_id])
    vert_num = int(model.mesh_vertnum[mesh_id])
    face_adr = int(model.mesh_faceadr[mesh_id])
    face_num = int(model.mesh_facenum[mesh_id])
    return {
        "id": mesh_id,
        "vertices": np.asarray(model.mesh_vert[vert_adr : vert_adr + vert_num], dtype=np.float64).tolist(),
        "faces": np.asarray(model.mesh_face[face_adr : face_adr + face_num], dtype=np.int64).tolist(),
    }


def mujoco_geom_rgba(model, geom_id: int) -> np.ndarray:
    mat_id = int(model.geom_matid[geom_id])
    if 0 <= mat_id < int(model.nmat):
        rgba = np.asarray(model.mat_rgba[mat_id], dtype=np.float64)
    else:
        rgba = np.asarray(model.geom_rgba[geom_id], dtype=np.float64)
    if np.allclose(rgba, 0.0):
        rgba = np.array([0.66, 0.68, 0.68, 1.0], dtype=np.float64)
    return np.clip(rgba, 0.0, 1.0)


def load_template_scene(args: argparse.Namespace) -> None:
    template_path = args.template_blend.expanduser().resolve()
    if not template_path.exists():
        raise FileNotFoundError(f"template .blend not found: {template_path}")
    print(f"[render_trajectory] template -> {template_path}", flush=True)
    bpy.ops.wm.open_mainfile(filepath=str(template_path))
    delete_template_collections(parse_name_list(args.template_delete_collections))
    delete_template_objects(parse_name_list(args.template_delete_objects))
    delete_previous_imported_robot()


def scale_template_lights(scale: float) -> None:
    scale = max(0.0, float(scale))
    changed = []
    for obj in bpy.data.objects:
        if obj.type != "LIGHT":
            continue
        original = float(obj.data.energy)
        obj.data.energy = original * scale
        if original > 0.0:
            changed.append(f"{obj.name}:{original:.1f}->{obj.data.energy:.1f}")
    if changed:
        print(f"[render_trajectory] template light scale={scale:.3f} " + ", ".join(changed), flush=True)


def delete_previous_imported_robot() -> None:
    prefixes = ("geom:", "body:")
    removed = 0
    for obj in list(bpy.data.objects):
        if obj.name.startswith(prefixes):
            bpy.data.objects.remove(obj, do_unlink=True)
            removed += 1
    if removed:
        print(f"[render_trajectory] removed {removed} previously imported robot objects from template", flush=True)
    purge_orphan_robot_data()


def purge_orphan_robot_data() -> None:
    purged = 0
    for collection in (bpy.data.actions, bpy.data.meshes, bpy.data.materials):
        for datablock in list(collection):
            if datablock.users == 0 and datablock.name.startswith(("body:", "geom:", "mj_")):
                collection.remove(datablock)
                purged += 1
    if purged:
        print(f"[render_trajectory] purged {purged} orphan robot data-blocks from template", flush=True)


def delete_template_collections(names: list[str]) -> None:
    for name in names:
        collection = bpy.data.collections.get(name)
        if collection is not None:
            delete_collection_recursive(collection)


def delete_template_objects(names: list[str]) -> None:
    removed = []
    for name in names:
        obj = bpy.data.objects.get(name)
        if obj is None:
            continue
        bpy.data.objects.remove(obj, do_unlink=True)
        removed.append(name)
    if removed:
        print("[render_trajectory] removed template objects: " + ", ".join(removed), flush=True)


def delete_collection_recursive(collection: bpy.types.Collection) -> None:
    for child in list(collection.children):
        delete_collection_recursive(child)
    for obj in list(collection.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    if collection.name in bpy.data.collections:
        bpy.data.collections.remove(collection)


def parse_name_list(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


def template_focus_object() -> bpy.types.Object | None:
    camera = bpy.context.scene.camera
    if camera is not None:
        focus = getattr(camera.data.dof, "focus_object", None) if camera.data.dof.use_dof else None
        if focus is not None:
            return focus
        for constraint in camera.constraints:
            target = getattr(constraint, "target", None)
            if constraint.type in {"TRACK_TO", "DAMPED_TRACK", "COPY_LOCATION"} and target is not None:
                return target
    return bpy.data.objects.get("cam_target") or bpy.data.objects.get("cam_focus")


def transform_body_positions(
    args: argparse.Namespace,
    scene_desc: dict,
    body_pos: np.ndarray,
    *,
    using_template: bool,
) -> np.ndarray:
    if not using_template or args.no_template_center_trajectory:
        return body_pos
    target_body = body_id_by_name(scene_desc, args.camera_target_body)
    if target_body is None:
        target_body = 1 if body_pos.shape[1] > 1 else 0
    focus = template_focus_object()
    dest_xy = np.array((0.0, 0.0), dtype=np.float64)
    if focus is not None:
        dest_xy = np.asarray(focus.location[:2], dtype=np.float64)
    source_xy = np.asarray(body_pos[0, target_body, :2], dtype=np.float64)
    offset = dest_xy - source_xy
    out = np.asarray(body_pos, dtype=np.float64).copy()
    out[:, :, 0] += float(offset[0])
    out[:, :, 1] += float(offset[1])
    print(
        "[render_trajectory] template centered trajectory "
        f"target_body={target_body} xy_offset=({offset[0]:.3f}, {offset[1]:.3f})",
        flush=True,
    )
    return out


def validate_trajectory(data, metadata: dict, scene_desc: dict) -> None:
    required = ("time", "body_pos", "body_quat")
    missing = [name for name in required if name not in data.files]
    if missing:
        raise ValueError(f"trajectory is missing arrays: {', '.join(missing)}")
    if data["body_pos"].shape[1] == 0:
        raise ValueError("trajectory has no body poses; record it without --no-body-poses")
    nbody = len(scene_desc.get("bodies", ()))
    if data["body_pos"].shape[1] != nbody:
        raise ValueError(
            f"body_pos has {data['body_pos'].shape[1]} bodies but scene has {nbody}"
        )
    if data["body_quat"].shape[:2] != data["body_pos"].shape[:2]:
        raise ValueError("body_quat shape must match body_pos on [T, nbody]")
    if metadata.get("format") != "unitree-deploy-trajectory-v1":
        print(f"[render_trajectory] warning: unknown metadata format {metadata.get('format')!r}")


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def configure_scene(args: argparse.Namespace, data, metadata: dict, *, using_template: bool = False) -> None:
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = max(1, int(data["time"].shape[0]))
    scene.frame_set(1)
    scene.render.fps = int(round(args.fps))
    scene.render.resolution_x = int(args.resolution[0])
    scene.render.resolution_y = int(args.resolution[1])
    scene.render.film_transparent = False

    if using_template and args.engine == "auto":
        if args.background is not None:
            scene.world = bpy.data.worlds.new("world") if scene.world is None else scene.world
            configure_world(scene.world, args.background)
        configure_color_management(scene)
        if scene.render.engine == "CYCLES":
            configure_cycles(scene, args)
        elif scene.render.engine.startswith("BLENDER_EEVEE"):
            configure_eevee(scene, args)
    else:
        scene.world = bpy.data.worlds.new("world") if scene.world is None else scene.world
        if args.background is not None or not using_template:
            configure_world(scene.world, args.background or DEFAULT_BACKGROUND)
        configure_color_management(scene)
        if args.engine == "cycles":
            scene.render.engine = "CYCLES"
            configure_cycles(scene, args)
        else:
            scene.render.engine = available_eevee_engine()
            configure_eevee(scene, args)

    configure_freestyle(scene, args.freestyle)

    print(
        "[render_trajectory] "
        f"robot={metadata.get('robot')} policy={metadata.get('policy')} "
        f"frames={scene.frame_end} fps={scene.render.fps} engine={scene.render.engine}"
    )


def available_eevee_engine() -> str:
    for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            bpy.context.scene.render.engine = engine
            return engine
        except TypeError:
            continue
    return "CYCLES"


def configure_freestyle(scene: bpy.types.Scene, mode: str) -> None:
    if not hasattr(scene.render, "use_freestyle"):
        return
    if mode == "on":
        scene.render.use_freestyle = True
    elif mode == "off":
        scene.render.use_freestyle = False


def configure_world(world: bpy.types.World, background: str) -> None:
    rgb = color_rgb(background)
    world.color = rgb
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background") if world.node_tree else None
    if bg is not None:
        set_principled_input(bg, "Color", (*rgb, 1.0))
        set_principled_input(bg, "Strength", 0.18)


def configure_color_management(scene: bpy.types.Scene) -> None:
    view_settings = scene.view_settings
    for transform in ("AgX", "Filmic", "Standard"):
        try:
            view_settings.view_transform = transform
            break
        except TypeError:
            continue
    for look in ("Medium High Contrast", "Medium Contrast", "None"):
        try:
            view_settings.look = look
            break
        except TypeError:
            continue
    view_settings.exposure = 0.0
    view_settings.gamma = 1.0


def configure_cycles(scene: bpy.types.Scene, args: argparse.Namespace) -> None:
    scene.cycles.samples = int(args.samples)
    scene.cycles.use_denoising = True
    set_attr_if_exists(scene.cycles, "max_bounces", 8)
    set_attr_if_exists(scene.cycles, "diffuse_bounces", 3)
    set_attr_if_exists(scene.cycles, "glossy_bounces", 4)
    set_attr_if_exists(scene.cycles, "transparent_max_bounces", 4)


def configure_eevee(scene: bpy.types.Scene, args: argparse.Namespace) -> None:
    del args
    eevee = getattr(scene, "eevee", None)
    if eevee is None:
        return
    set_attr_if_exists(eevee, "taa_render_samples", 128)
    set_attr_if_exists(eevee, "taa_samples", 64)
    set_attr_if_exists(eevee, "use_gtao", True)
    set_attr_if_exists(eevee, "gtao_distance", 4.0)
    set_attr_if_exists(eevee, "gtao_factor", 1.6)
    set_attr_if_exists(eevee, "use_bloom", True)
    set_attr_if_exists(eevee, "bloom_intensity", 0.025)
    set_attr_if_exists(eevee, "shadow_cube_size", "4096")
    set_attr_if_exists(eevee, "shadow_cascade_size", "4096")


def set_attr_if_exists(obj, name: str, value) -> None:
    if hasattr(obj, name):
        try:
            setattr(obj, name, value)
        except TypeError:
            pass


def build_materials(scene_desc: dict, *, style: str) -> dict[tuple[float, ...], bpy.types.Material]:
    materials = {}
    for geom in scene_desc.get("geoms", ()):
        rgba = tuple(float(v) for v in geom.get("rgba", (0.66, 0.68, 0.68, 1.0)))
        key = rgba
        if key in materials:
            continue
        color, roughness, metallic = material_style_for_rgba(rgba, style=style)
        mat = bpy.data.materials.new(f"mj_{style}_mat_{len(materials)}")
        mat.diffuse_color = color
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf is not None:
            set_principled_input(bsdf, "Base Color", color)
            set_principled_input(bsdf, "Roughness", roughness)
            set_principled_input(bsdf, "Metallic", metallic)
            set_principled_input(bsdf, "Alpha", color[3])
        if color[3] < 0.999:
            mat.blend_method = "BLEND"
            if hasattr(mat, "use_screen_refraction"):
                mat.use_screen_refraction = True
        materials[key] = mat
    return materials


def material_style_for_rgba(rgba: tuple[float, ...], *, style: str) -> tuple[tuple[float, float, float, float], float, float]:
    if style == "mujoco":
        return rgba, 0.58, 0.02

    r, g, b, a = rgba
    rgb_mean = (r + g + b) / 3.0
    if a < 0.999:
        return (r, g, b, a), 0.64, 0.0
    if rgb_mean <= 0.28:
        return (0.025, 0.027, 0.028, a), 0.62, 0.18
    if rgb_mean >= 0.62:
        return (0.74, 0.76, 0.74, a), 0.48, 0.04
    return (0.42, 0.44, 0.43, a), 0.54, 0.08


def set_principled_input(node, name: str, value) -> None:
    if name in node.inputs:
        node.inputs[name].default_value = value


def create_body_empties(scene_desc: dict) -> list[bpy.types.Object]:
    empties = []
    for body in scene_desc.get("bodies", ()):
        body_id = int(body["id"])
        name = body.get("name") or f"body_{body_id}"
        empty = bpy.data.objects.new(f"body:{body_id}:{name}", None)
        empty.empty_display_type = "PLAIN_AXES"
        empty.empty_display_size = 0.08
        empty.rotation_mode = "QUATERNION"
        bpy.context.collection.objects.link(empty)
        empties.append(empty)
    return empties


def create_scene_geoms(
    scene_desc: dict,
    body_empties: list[bpy.types.Object],
    materials: dict[tuple[float, ...], bpy.types.Material],
    geom_groups: set[int],
) -> None:
    meshes = scene_desc.get("meshes", {})
    for geom in scene_desc.get("geoms", ()):
        geom_id = int(geom["id"])
        if int(geom.get("group", 0)) not in geom_groups:
            continue
        geom_type = str(geom.get("type", "")).lower()
        if geom_type == "hfield":
            print(f"[render_trajectory] skipping hfield geom {geom_id}")
            continue
        if geom_type == "plane":
            continue

        obj = create_geom_object(geom, meshes)
        if obj is None:
            continue
        mat = material_for_geom(geom, materials)
        assign_material(obj, mat)
        obj.parent = body_empties[int(geom["body_id"])]
        obj.location = tuple(float(v) for v in geom.get("pos", (0.0, 0.0, 0.0)))
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = wxyz_quat(geom.get("quat", (1.0, 0.0, 0.0, 0.0)))
        obj.name = f"geom:{geom_id}:{obj.name}"


def create_geom_object(geom: dict, meshes: dict) -> bpy.types.Object | None:
    geom_type = str(geom.get("type", "")).lower()
    size = np.asarray(geom.get("size", (0.0, 0.0, 0.0)), dtype=np.float64)
    name = geom.get("name") or f"geom_{geom['id']}"

    if geom_type == "mesh":
        mesh_payload = meshes.get(str(int(geom.get("mesh_id", -1))))
        if mesh_payload is None:
            print(f"[render_trajectory] skipping mesh geom {geom['id']}: mesh payload missing")
            return None
        return create_mesh_geom(mesh_payload, name)
    if geom_type == "box":
        bpy.ops.mesh.primitive_cube_add(size=2.0)
        obj = bpy.context.object
        obj.name = name
        obj.scale = tuple(float(v) for v in size)
        return obj
    if geom_type == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=float(size[0]))
        bpy.context.object.name = name
        return bpy.context.object
    if geom_type == "ellipsoid":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=1.0)
        obj = bpy.context.object
        obj.name = name
        obj.scale = tuple(float(v) for v in size)
        return obj
    if geom_type == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=float(size[0]), depth=float(2.0 * size[1]))
        bpy.context.object.name = name
        return bpy.context.object
    if geom_type == "capsule":
        return create_capsule(name, radius=float(size[0]), half_length=float(size[1]))

    print(f"[render_trajectory] skipping unsupported geom {geom['id']} type={geom_type}")
    return None


def create_mesh_geom(mesh_payload: dict, name: str) -> bpy.types.Object:
    vertices = [tuple(float(v) for v in row) for row in mesh_payload["vertices"]]
    faces = [tuple(int(v) for v in row) for row in mesh_payload["faces"]]
    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    shade_smooth(obj)
    return obj


def create_capsule(name: str, *, radius: float, half_length: float) -> bpy.types.Object:
    vertices = []
    faces = []
    rings = 12
    segments = 32
    for i in range(rings + 1):
        theta = -math.pi / 2.0 + (math.pi / 2.0) * i / rings
        z = -half_length + radius * math.sin(theta)
        r = radius * math.cos(theta)
        add_ring(vertices, z, r, segments)
    for i in range(rings + 1):
        theta = (math.pi / 2.0) * i / rings
        z = half_length + radius * math.sin(theta)
        r = radius * math.cos(theta)
        add_ring(vertices, z, r, segments)
    for ring_i in range(2 * (rings + 1) - 1):
        for seg_i in range(segments):
            a = ring_i * segments + seg_i
            b = ring_i * segments + (seg_i + 1) % segments
            c = (ring_i + 1) * segments + (seg_i + 1) % segments
            d = (ring_i + 1) * segments + seg_i
            faces.append((a, b, c, d))
    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    shade_smooth(obj)
    return obj


def add_ring(vertices: list[tuple[float, float, float]], z: float, radius: float, segments: int) -> None:
    for seg_i in range(segments):
        angle = 2.0 * math.pi * seg_i / segments
        vertices.append((radius * math.cos(angle), radius * math.sin(angle), z))


def shade_smooth(obj: bpy.types.Object) -> None:
    if obj.type == "MESH":
        for polygon in obj.data.polygons:
            polygon.use_smooth = True


def material_for_geom(geom: dict, materials: dict[tuple[float, ...], bpy.types.Material]) -> bpy.types.Material:
    rgba = tuple(float(v) for v in geom.get("rgba", (0.66, 0.68, 0.68, 1.0)))
    return materials[rgba]


def assign_material(obj: bpy.types.Object, mat: bpy.types.Material) -> None:
    targets = [obj]
    children = getattr(obj, "children_recursive", ())
    targets.extend(child for child in children if child.type == "MESH")
    for target in targets:
        if target.type == "MESH":
            target.data.materials.append(mat)


def add_stage(args: argparse.Namespace, scene_desc: dict, body_pos: np.ndarray) -> StageLayout:
    stage = compute_stage_layout(args, scene_desc, body_pos)
    mat = create_floor_material(args.floor_color)

    bpy.ops.mesh.primitive_plane_add(size=stage.size, location=(stage.center.x, stage.center.y, 0.0))
    floor = bpy.context.object
    floor.name = "stage_floor"
    floor.data.materials.append(mat)
    floor.hide_select = True

    if not args.no_grid:
        add_floor_grid(args, stage)
    return stage


def compute_stage_layout(args: argparse.Namespace, scene_desc: dict, body_pos: np.ndarray) -> StageLayout:
    target_body = body_id_by_name(scene_desc, args.camera_target_body)
    if target_body is None:
        target_body = 1 if body_pos.shape[1] > 1 else 0
    xy = np.asarray(body_pos[:, target_body, :2], dtype=np.float64)
    xy = xy[np.isfinite(xy).all(axis=1)]
    if xy.size == 0:
        return StageLayout(mathutils.Vector((0.0, 0.0, 0.0)), float(args.floor_size))
    lower = xy.min(axis=0)
    upper = xy.max(axis=0)
    center_xy = 0.5 * (lower + upper)
    path_span = float(np.max(upper - lower))
    size = max(float(args.floor_size), path_span + 2.0 * float(args.stage_margin))
    return StageLayout(mathutils.Vector((float(center_xy[0]), float(center_xy[1]), 0.0)), size)


def create_floor_material(color: str) -> bpy.types.Material:
    rgb = color_rgb(color)
    mat = bpy.data.materials.new("paper_demo_floor")
    mat.diffuse_color = (*rgb, 1.0)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    if bsdf is None:
        return mat
    set_principled_input(bsdf, "Base Color", (*rgb, 1.0))
    set_principled_input(bsdf, "Roughness", 0.86)
    set_principled_input(bsdf, "Metallic", 0.0)

    noise = nodes.new(type="ShaderNodeTexNoise")
    noise.name = "floor_micro_noise"
    set_principled_input(noise, "Scale", 42.0)
    set_principled_input(noise, "Detail", 7.0)
    set_principled_input(noise, "Roughness", 0.58)
    bump = nodes.new(type="ShaderNodeBump")
    bump.name = "floor_subtle_bump"
    set_principled_input(bump, "Strength", 0.025)
    set_principled_input(bump, "Distance", 0.05)
    if "Fac" in noise.outputs and "Height" in bump.inputs:
        links.new(noise.outputs["Fac"], bump.inputs["Height"])
    if "Normal" in bump.outputs and "Normal" in bsdf.inputs:
        links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def add_floor_grid(args: argparse.Namespace, stage: StageLayout) -> None:
    spacing = max(0.05, float(args.grid_spacing))
    width = max(0.001, float(args.grid_line_width))
    major_every = max(1, int(args.grid_major_every))
    minor = create_grid_mesh(
        "stage_grid_minor",
        stage,
        spacing=spacing,
        line_width=width,
        major_every=major_every,
        major=False,
        z=0.003,
    )
    major = create_grid_mesh(
        "stage_grid_major",
        stage,
        spacing=spacing,
        line_width=width * 1.75,
        major_every=major_every,
        major=True,
        z=0.004,
    )
    minor.data.materials.append(create_grid_material("stage_grid_minor_mat", "#3d4848", 0.34))
    major.data.materials.append(create_grid_material("stage_grid_major_mat", "#566262", 0.46))
    minor.hide_select = True
    major.hide_select = True


def create_grid_mesh(
    name: str,
    stage: StageLayout,
    *,
    spacing: float,
    line_width: float,
    major_every: int,
    major: bool,
    z: float,
) -> bpy.types.Object:
    half = stage.size / 2.0
    x0 = stage.center.x - half
    x1 = stage.center.x + half
    y0 = stage.center.y - half
    y1 = stage.center.y + half
    count = int(math.floor(stage.size / spacing))
    start_x = stage.center.x - 0.5 * count * spacing
    start_y = stage.center.y - 0.5 * count * spacing
    vertices: list[tuple[float, float, float]] = []
    faces: list[tuple[int, int, int, int]] = []

    for i in range(count + 1):
        is_major = i % major_every == 0
        if is_major != major:
            continue
        x = start_x + i * spacing
        y = start_y + i * spacing
        add_grid_rect(vertices, faces, x - line_width / 2.0, y0, x + line_width / 2.0, y1, z)
        add_grid_rect(vertices, faces, x0, y - line_width / 2.0, x1, y + line_width / 2.0, z)

    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def add_grid_rect(vertices, faces, x0: float, y0: float, x1: float, y1: float, z: float) -> None:
    base = len(vertices)
    vertices.extend(((x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)))
    faces.append((base, base + 1, base + 2, base + 3))


def create_grid_material(name: str, color: str, alpha: float) -> bpy.types.Material:
    rgb = color_rgb(color)
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*rgb, alpha)
    mat.use_nodes = True
    mat.blend_method = "BLEND"
    mat.show_transparent_back = False
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        set_principled_input(bsdf, "Base Color", (*rgb, alpha))
        set_principled_input(bsdf, "Alpha", alpha)
        set_principled_input(bsdf, "Roughness", 0.78)
    return mat


def create_camera(args: argparse.Namespace, *, using_template: bool = False) -> bpy.types.Object:
    if using_template and bpy.context.scene.camera is not None:
        camera = bpy.context.scene.camera
        camera.rotation_mode = "QUATERNION"
        if camera.data.dof.use_dof and template_focus_object() is not None:
            camera.data.dof.focus_object = template_focus_object()
        return camera
    camera_data = bpy.data.cameras.new("camera")
    camera_data.lens = float(args.focal_length)
    camera = bpy.data.objects.new("camera", camera_data)
    camera.rotation_mode = "QUATERNION"
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera
    return camera


def add_lighting(args: argparse.Namespace, stage: StageLayout) -> None:
    c = stage.center
    bpy.ops.object.light_add(type="AREA", location=(c.x - 3.6, c.y - 4.8, 6.2))
    key = bpy.context.object
    key.name = "key_area"
    key.data.energy = 950.0
    key.data.size = max(3.5, float(args.shadow_softness))
    enable_soft_shadows(key)

    bpy.ops.object.light_add(type="AREA", location=(c.x + 4.4, c.y + 3.6, 3.2))
    fill = bpy.context.object
    fill.name = "soft_fill"
    fill.data.energy = 160.0
    fill.data.size = 7.5
    enable_soft_shadows(fill)

    bpy.ops.object.light_add(type="AREA", location=(c.x + 0.8, c.y + 5.2, 4.8))
    rim = bpy.context.object
    rim.name = "cool_rim_area"
    rim.data.energy = 420.0
    rim.data.size = 4.5
    rim.data.color = (0.78, 0.86, 1.0)
    enable_soft_shadows(rim)

    bpy.ops.object.light_add(type="SUN", location=(c.x, c.y, 8.0))
    sun = bpy.context.object
    sun.name = "thin_rim_sun"
    sun.data.energy = 0.28
    sun.rotation_euler = (math.radians(48.0), 0.0, math.radians(-38.0))


def enable_soft_shadows(light: bpy.types.Object) -> None:
    set_attr_if_exists(light.data, "use_shadow", True)
    set_attr_if_exists(light.data, "use_contact_shadow", True)
    set_attr_if_exists(light.data, "contact_shadow_distance", 2.0)


def animate_bodies(
    body_empties: list[bpy.types.Object],
    body_pos: np.ndarray,
    body_quat: np.ndarray,
    *,
    fps: float,
) -> None:
    del fps
    for frame_i in range(int(body_pos.shape[0])):
        frame = frame_i + 1
        for body_id, empty in enumerate(body_empties):
            empty.location = tuple(float(v) for v in body_pos[frame_i, body_id])
            empty.rotation_quaternion = wxyz_quat(body_quat[frame_i, body_id])
            empty.keyframe_insert(data_path="location", frame=frame)
            empty.keyframe_insert(data_path="rotation_quaternion", frame=frame)


def animate_follow_lights(args: argparse.Namespace, scene_desc: dict, body_pos: np.ndarray) -> None:
    focus_object = template_focus_object()
    lights = template_follow_lights(args.follow_light_names)
    if not lights:
        return
    remove_light_aim_constraints(lights)
    tracking_target = ensure_light_tracking_target()
    detach_lights_keep_world_transform(lights)
    add_light_tracking_constraints(lights, tracking_target)
    target_body = body_id_by_name(scene_desc, args.camera_target_body)
    if target_body is None:
        target_body = 1 if len(scene_desc.get("bodies", ())) > 1 else 0
    target0 = mathutils.Vector(tuple(float(v) for v in body_pos[0, target_body]))
    offsets = template_light_offsets(lights, focus_object, target0)
    print(
        "[render_trajectory] following/aiming lights: " + ", ".join(light.name for light in lights),
        flush=True,
    )
    print(
        "[render_trajectory] light offsets: "
        + ", ".join(f"{name}=({offset.x:.2f},{offset.y:.2f},{offset.z:.2f})" for name, offset in offsets.items()),
        flush=True,
    )
    lookat_vec = mathutils.Vector(args.camera_lookat_offset)
    for frame_i in range(int(body_pos.shape[0])):
        frame = frame_i + 1
        target = mathutils.Vector(tuple(float(v) for v in body_pos[frame_i, target_body]))
        aim_target = target + lookat_vec
        set_world_location(tracking_target, aim_target)
        tracking_target.keyframe_insert(data_path="location", frame=frame)
        for light in lights:
            light_origin = target + offsets[light.name]
            set_world_location(light, light_origin)
            light.keyframe_insert(data_path="location", frame=frame)


def template_follow_lights(value: str) -> list[bpy.types.Object]:
    names = parse_name_list(value)
    if names:
        lights = []
        for name in names:
            obj = bpy.data.objects.get(name)
            if obj is None:
                print(f"[render_trajectory] warning: follow light {name!r} not found")
            elif obj.type != "LIGHT":
                print(f"[render_trajectory] warning: {name!r} is not a light")
            else:
                lights.append(obj)
        return lights
    return [obj for obj in bpy.data.objects if obj.type == "LIGHT" and float(obj.data.energy) > 0.0]


def ensure_light_tracking_target() -> bpy.types.Object:
    obj = bpy.data.objects.get("robot_light_target")
    if obj is not None:
        return obj
    obj = bpy.data.objects.new("robot_light_target", None)
    obj.empty_display_type = "SPHERE"
    obj.empty_display_size = 0.12
    bpy.context.collection.objects.link(obj)
    return obj


def detach_lights_keep_world_transform(lights: list[bpy.types.Object]) -> None:
    for light in lights:
        world_matrix = light.matrix_world.copy()
        light.parent = None
        light.matrix_world = world_matrix


def template_light_offsets(
    lights: list[bpy.types.Object],
    focus_object: bpy.types.Object | None,
    target0: mathutils.Vector,
) -> dict[str, mathutils.Vector]:
    offsets = {}
    focus_location = world_location(focus_object) if focus_object is not None else None
    for light in lights:
        if light.name in DEFAULT_TEMPLATE_LIGHT_OFFSETS:
            offsets[light.name] = mathutils.Vector(DEFAULT_TEMPLATE_LIGHT_OFFSETS[light.name])
            continue
        if focus_location is not None:
            offset = world_location(light) - focus_location
        else:
            offset = world_location(light) - target0
        if offset.z < 2.0:
            offset.z = 3.2
        offsets[light.name] = offset
    return offsets


def add_light_tracking_constraints(lights: list[bpy.types.Object], target: bpy.types.Object) -> None:
    for light in lights:
        enable_soft_shadows(light)
        constraint = light.constraints.new(type="DAMPED_TRACK")
        constraint.name = "Track Robot"
        constraint.target = target
        if hasattr(constraint, "track_axis"):
            constraint.track_axis = "TRACK_NEGATIVE_Z"
    print(
        f"[render_trajectory] light tracking target: {target.name}",
        flush=True,
    )


def remove_light_aim_constraints(lights: list[bpy.types.Object]) -> None:
    removed = []
    for light in lights:
        for constraint in list(light.constraints):
            if constraint.type in {"TRACK_TO", "DAMPED_TRACK", "LOCKED_TRACK"}:
                removed.append(f"{light.name}:{constraint.name}")
                light.constraints.remove(constraint)
    if removed:
        print("[render_trajectory] removed template light aim constraints: " + ", ".join(removed), flush=True)


def is_descendant_of(obj: bpy.types.Object, ancestor: bpy.types.Object) -> bool:
    parent = obj.parent
    while parent is not None:
        if parent == ancestor:
            return True
        parent = parent.parent
    return False


def world_location(obj: bpy.types.Object) -> mathutils.Vector:
    return obj.matrix_world.translation.copy()


def set_world_location(obj: bpy.types.Object, location: mathutils.Vector) -> None:
    if obj.parent is None:
        obj.location = location
        return
    obj.location = obj.parent.matrix_world.inverted() @ location


def animate_follow_camera(
    camera: bpy.types.Object,
    scene_desc: dict,
    body_pos: np.ndarray,
    target_body_name: str,
    offset: tuple[float, float, float],
    lookat_offset: tuple[float, float, float],
    *,
    focus_object: bpy.types.Object | None = None,
) -> None:
    target_body = body_id_by_name(scene_desc, target_body_name)
    if target_body is None:
        print(f"[render_trajectory] camera target body {target_body_name!r} not found; using body 1")
        target_body = 1 if len(scene_desc.get("bodies", ())) > 1 else 0
    offset_vec = mathutils.Vector(offset)
    lookat_vec = mathutils.Vector(lookat_offset)
    for frame_i in range(int(body_pos.shape[0])):
        frame = frame_i + 1
        target = mathutils.Vector(tuple(float(v) for v in body_pos[frame_i, target_body])) + lookat_vec
        camera_origin = target + offset_vec
        camera.location = camera_origin
        look_at(camera, target, origin=camera_origin)
        camera.keyframe_insert(data_path="location", frame=frame)
        camera.keyframe_insert(data_path="rotation_quaternion", frame=frame)
        if focus_object is not None:
            focus_object.location = target
            focus_object.keyframe_insert(data_path="location", frame=frame)


def body_id_by_name(scene_desc: dict, name: str) -> int | None:
    for body in scene_desc.get("bodies", ()):
        if body.get("name") == name:
            return int(body["id"])
    return None


def look_at(
    obj: bpy.types.Object,
    target: mathutils.Vector,
    *,
    origin: mathutils.Vector | None = None,
) -> None:
    direction = target - (origin if origin is not None else world_location(obj))
    if direction.length <= 1e-9:
        return
    obj.rotation_mode = "QUATERNION"
    world_quat = direction.to_track_quat("-Z", "Y")
    if obj.parent is None:
        obj.rotation_quaternion = world_quat
    else:
        obj.rotation_quaternion = obj.parent.rotation_euler.to_quaternion().inverted() @ world_quat


def parse_geom_groups(value: str) -> set[int]:
    if not value.strip():
        return set(DEFAULT_GEOM_GROUPS)
    return {int(part.strip()) for part in value.split(",") if part.strip()}


def wxyz_quat(value) -> mathutils.Quaternion:
    return mathutils.Quaternion(tuple(float(v) for v in value))


def color_rgb(value: str) -> tuple[float, float, float]:
    text = value.strip()
    if text.startswith("#"):
        text = text[1:]
    if len(text) != 6:
        raise ValueError(f"expected #RRGGBB color, got {value!r}")
    return tuple(int(text[i : i + 2], 16) / 255.0 for i in (0, 2, 4))


if __name__ == "__main__":
    main()
