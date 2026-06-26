# web-policy

`web-policy` is a browser-based MuJoCo viewer for trained Unitree policy checkpoints. It intentionally lives outside `unitree-deploy`: `unitree-deploy` owns policy loading, observation construction, robot assets, and runtime primitives; this project owns the static web UI and the presentation server.

## Quick start

Install both projects in the same Python environment:

```bash
pip install -e /home/syw/.gitrepos/unitree-deploy
pip install -e /home/syw/.gitrepos/web_policy
```

Run a checkpoint:

```bash
web-policy --robot g1 --ckpt /home/syw/.gitrepos/unitree-deploy/ckpt/g1/vanilla_ppo_flat
```

Open `http://127.0.0.1:8000`.

## Static GitHub Pages export

After tuning a local demo, export a static browser simulation folder:

```bash
npm install

web-policy-export \
  --robot g1 \
  --ckpt /home/syw/.gitrepos/unitree-deploy/ckpt/g1/vanilla_ppo_flat \
  --out export/g1-demo \
  --overwrite
```

The export builds a self-contained static site that runs MuJoCo WASM and ONNX
Runtime Web in the browser. Command sliders and left-drag external forces affect
the live simulation. Push the output folder contents to a GitHub repository and
enable GitHub Pages for that branch or folder.

For local inspection:

```bash
cd export/g1-demo
python3 -m http.server 8080
```

## UI command schema

Each checkpoint can provide a `web_policy.yaml` or `web_demo.yaml` next to `policy.yaml` to describe the command controls shown in the browser. The current runtime keeps `web_demo.yaml` compatibility for migrated checkpoints; new templates should use `web_policy.yaml`.

A velocity-tracking example is available at `templates/velocity_command.yaml`.

## Template direction

See `docs/TEMPLATE_PROPOSAL.md` for the proposed template structure and customization workflow.
