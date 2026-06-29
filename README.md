# policy-blender-renderer

Export a Blender `.blend` file with an imported robot trajectory:

```bash
blender -b \
  --python scripts/render_trajectory.py \
  -- \
  --trajectory /path/to/trajectory.npz \
  --scene-json /path/to/scene.json \
  --template-blend presets/umi_on_legs_template.blend \
  --out export/blends/g1_walk.blend
```

The saved file includes both the template name and a timestamp, for example
`export/blends/g1_walk-umi_on_legs_template-20260629-204347.blend`.

Available templates:

- `presets/umi_on_legs_template.blend`: balanced default stage.
- `presets/green_template.blend`: pale green floor, bright cyan-white grid, and deep green backdrop.
- `presets/white_template.blend`: bright white floor and clean high-key lighting.
