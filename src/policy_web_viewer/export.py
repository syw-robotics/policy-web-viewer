from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path
import xml.etree.ElementTree as ET

from unitree_deploy.robot_model.robot_config import DEFAULT_ROBOT, DEFAULT_TERRAIN
from policy_web_viewer.simulator import OnlineDemoSimulator, build_config


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export an interactive browser MuJoCo/ONNX demo.")
    parser.add_argument("--out", type=Path, required=True, help="Output directory for the static browser demo.")
    parser.add_argument("--robot", default=DEFAULT_ROBOT)
    parser.add_argument("--model-xml", type=Path, help="Optional MuJoCo XML override.")
    parser.add_argument("--terrain", default=DEFAULT_TERRAIN)
    parser.add_argument("--ckpt", type=Path, help="Checkpoint directory containing policy.yaml.")
    parser.add_argument("--multi-ckpt", type=Path, help="Multi-policy manifest.")
    parser.add_argument("--overwrite", action="store_true", help="Replace an existing output directory.")
    parser.add_argument("--skip-build", action="store_true", help="Write demo data without running Vite.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    export_wasm_demo(
        out=args.out,
        ckpt=args.ckpt,
        multi_ckpt=args.multi_ckpt,
        robot=args.robot,
        model_xml=args.model_xml,
        terrain=args.terrain,
        overwrite=args.overwrite,
        skip_build=args.skip_build,
    )


# Main function to export a WASM demo
def export_wasm_demo(
    *,
    out: Path,
    ckpt: Path | None,
    multi_ckpt: Path | None,
    robot: str,
    model_xml: Path | None,
    terrain: str | Path,
    overwrite: bool,
    skip_build: bool,
) -> None:
    config = build_config(
        ckpt=ckpt,
        multi_ckpt=multi_ckpt,
        robot=robot,
        model_xml=model_xml,
        terrain=terrain,
        auto_start=False,
    )
    simulator = OnlineDemoSimulator(config)

    output_dir = out.expanduser().resolve()
    if output_dir.exists() and not overwrite:
        raise FileExistsError(f"{output_dir} already exists; pass --overwrite to replace it")

    if not skip_build:
        _build_wasm_runtime(output_dir)
    else:
        _prepare_output_dir(output_dir, overwrite=overwrite)
        runtime_root = Path(__file__).resolve().parents[2] / "frontend"
        shutil.copytree(runtime_root, output_dir / "runtime-source", dirs_exist_ok=True)

    demo_dir = output_dir / "demo"
    if demo_dir.exists():
        shutil.rmtree(demo_dir)
    demo_dir.mkdir(parents=True, exist_ok=True)

    scene_xml = _write_browser_scene(config.robot, demo_dir / "scenes")
    _write_browser_policy(simulator, demo_dir / "policy")
    _write_json(
        demo_dir / "manifest.json",
        {
            "format": "policy-web-viewer-wasm-v1",
            "mode": "wasm",
            "scene_xml": scene_xml,
            "policy_config": "policy/policy.json",
            "robot": config.robot.name,
            "terrain": config.robot.terrain,
            "policy": simulator.active_profile_name,
            "sim_hz": simulator.config.sim_hz,
            "physics_dt": simulator.profile.policy.physics_dt,
            "policy_step_dt": simulator.profile.policy.policy_step_dt,
            "decimation": simulator.profile.policy.decimation,
            "initial_qpos": simulator.initial_qpos.tolist(),
            "sdk_joint_order": simulator.profile.sdk_joint_order,
            "obs_joint_order": simulator.profile.obs_joint_order,
            "obs_to_sdk": simulator.profile.obs_to_sdk.tolist(),
            "kp_policy": simulator.profile.kp_policy.tolist(),
            "kd_policy": simulator.profile.kd_policy.tolist(),
            "gyro_sensor": list(simulator.gyro_sensor) if simulator.gyro_sensor is not None else None,
            "command_schema": simulator.command_schema.to_json(),
            "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
        },
        indent=2,
    )
    (output_dir / ".nojekyll").write_text("", encoding="utf-8")
    (output_dir / "README.md").write_text(_wasm_readme(config.robot.name), encoding="utf-8")
    print(f"[policy-web-viewer-export] wrote browser-sim demo to {output_dir}")


# Prepare the output directory, removing it if it exists and overwrite is True
def _prepare_output_dir(path: Path, *, overwrite: bool) -> None:
    if path.exists():
        if not overwrite:
            raise FileExistsError(f"{path} already exists; pass --overwrite to replace it")
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


# Build the WASM runtime using npm and Vite, writing to the output directory
def _build_wasm_runtime(output_dir: Path) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    cmd = ["npm", "run", "build:wasm", "--", "--outDir", str(output_dir), "--emptyOutDir"]
    try:
        subprocess.run(cmd, cwd=repo_root, check=True)
    except FileNotFoundError as exc:
        raise RuntimeError("npm is required to build browser exports") from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            "failed to build the browser runtime; run `npm install` in the policy_web_viewer repo first"
        ) from exc


# Write a MuJoCo XML scene for the browser runtime, copying meshes and assets
def _write_browser_scene(robot, scenes_dir: Path) -> str:
    scene_name = robot.name
    scene_dir = scenes_dir / scene_name
    scene_dir.mkdir(parents=True, exist_ok=True)

    root = ET.parse(robot.xml_path).getroot()
    compiler = root.find("compiler")
    mesh_dir = robot.config_dir / "meshes"
    if compiler is not None and mesh_dir.exists():
        compiler.set("meshdir", "./meshes/")
        _copy_tree_files(mesh_dir, scene_dir / "meshes")

    asset = root.find("asset")
    if asset is not None:
        for element in asset.iter():
            value = element.get("file")
            if not value:
                continue
            source = Path(value).expanduser()
            if not source.is_absolute():
                continue
            target_rel = Path("assets") / source.name
            target = scene_dir / target_rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            element.set("file", target_rel.as_posix())

    xml_name = f"{scene_name}.xml"
    xml_path = scene_dir / xml_name
    tree = ET.ElementTree(root)
    ET.indent(tree, space="  ")
    tree.write(xml_path, encoding="utf-8", xml_declaration=False)

    files = [
        path.relative_to(scenes_dir).as_posix()
        for path in sorted(scene_dir.rglob("*"))
        if path.is_file()
    ]
    _write_json(scenes_dir / "files.json", files, indent=2)
    return f"{scene_name}/{xml_name}"


# Copy all files from a source directory to a target directory
def _copy_tree_files(source_dir: Path, target_dir: Path) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    for source in source_dir.rglob("*"):
        if not source.is_file():
            continue
        target = target_dir / source.relative_to(source_dir)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


# Write the policy ONNX and metadata for the browser runtime
def _write_browser_policy(simulator: OnlineDemoSimulator, policy_dir: Path) -> None:
    policy_dir.mkdir(parents=True, exist_ok=True)
    profile = simulator.profile
    policy = profile.policy
    onnx_target = policy_dir / "policy.onnx"
    shutil.copy2(policy.model_path, onnx_target)
    payload = {
        "format": "policy-web-viewer-browser-policy-v1",
        "onnx_path": "./demo/policy/policy.onnx",
        "policy_input_name": policy.input_name,
        "policy_output_name": policy.action_output_name,
        "policy_step_dt": policy.policy_step_dt,
        "physics_dt": policy.physics_dt,
        "decimation": policy.decimation,
        "obs_prime_on_reset": policy.obs_prime_on_reset,
        "obs_group_concat_mode": policy.config.get("obs_group_concat_mode", "term_major"),
        "obs_use_scaled_prev_action": policy.obs_use_scaled_prev_action,
        "observations": policy.config["observations"],
        "action_dim": policy.action_dim,
        "action_clip": policy.action_clip,
        "action_to_obs_indices": policy.action_to_obs_indices.tolist(),
        "action_scaling": policy.action_scaling.tolist(),
        "default_joint_pos_obs": policy.default_joint_pos.tolist(),
        "default_joint_pos_action": policy.default_joint_pos_action.tolist(),
        "command_schema": simulator.command_schema.to_json(),
    }
    _write_json(policy_dir / "policy.json", payload, indent=2)


# Export a README.md in the exported WASM folder
def _wasm_readme(robot: str) -> str:
    return (
        f"# policy-web-viewer browser simulation demo ({robot})\n\n"
        "This directory is a static browser runtime. It runs MuJoCo WASM and ONNX Runtime Web in the browser, "
        "so command sliders and drag forces affect the live simulation.\n\n"
        "Deploy the contents of this directory to GitHub Pages. For local inspection, serve it with:\n\n"
        "```bash\n"
        "python3 -m http.server 8080\n"
        "```\n"
    )


# Write a JSON file with UTF-8 encoding
def _write_json(path: Path, payload, *, indent: int | None = None) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=indent, separators=None if indent else (",", ":")),
        encoding="utf-8",
    )



if __name__ == "__main__":
    main()
