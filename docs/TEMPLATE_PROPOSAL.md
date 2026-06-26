# web-policy Template Proposal

## Goal

Make `web_policy` a thin, reusable presentation template for trained policies. Users should customize UI text, command controls, visual toggles, and optional policy-specific panels without changing `unitree-deploy` core runtime code.

## Proposed structure

```text
web_policy/
├── src/web_policy/            # generic server, simulator bridge, static UI
├── templates/                 # reusable UI schema examples
├── examples/                  # complete example policy presentation folders
└── docs/                      # customization docs
```

A user-facing policy presentation folder should look like this:

```text
my_policy_showcase/
├── policy.yaml
├── policy.onnx
├── web_policy.yaml            # UI command schema and display metadata
├── assets/                    # optional screenshots, logos, motion clips
└── panels/                    # optional custom JS/CSS fragments in a later phase
```

## Customization layers

1. `web_policy.yaml` defines command dimensions, labels, ranges, defaults, units, hotkeys, and simple control types such as sliders, toggles, and selects.
2. Presentation metadata can be added to `web_policy.yaml`: title, subtitle, default camera, enabled debug overlays, readout labels, and brand/assets.
3. Advanced users can add plugin-style panels that consume `/api/status`, `/api/frame`, or policy-specific API endpoints.
4. The simulator bridge remains generic: it only needs a command vector compatible with the policy runtime.

## Why this fits diverse observations

Observation construction and policy inference stay in `unitree-deploy`, where custom observations already belong. `web_policy` only asks the policy for its runtime command dimension and exposes a UI that produces that vector. This avoids forcing every policy's observation design into a single YAML abstraction.

## Near-term implementation steps

1. Rename the schema lookup to prefer `web_policy.yaml`, falling back to `web_demo.yaml` for compatibility.
2. Add metadata fields under `ui:` in the schema file.
3. Add a `web-policy init` command that copies a template into a checkpoint or showcase folder.
4. Document two templates first: velocity tracking and motion tracking.
