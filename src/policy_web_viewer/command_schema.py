from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

import numpy as np

from unitree_deploy.policy.base_policy import BasePolicy
from unitree_deploy.utils.yaml_utils import load_yaml


SUPPORTED_COMMAND_TYPES = {"slider", "select", "toggle"}
DEFAULT_VELOCITY_DIMS = (
    ("lin_vel_x", "Lin Vel X", "m/s", "KeyW", "KeyS"),
    ("lin_vel_y", "Lin Vel Y", "m/s", "KeyA", "KeyD"),
    ("ang_vel_yaw", "Ang Vel Yaw", "rad/s", "KeyQ", "KeyE"),
)


@dataclass(frozen=True)
class CommandOption:
    label: str
    value: float

    def to_json(self) -> dict:
        return {
            "label": self.label,
            "value": self.value,
        }


@dataclass(frozen=True)
class CommandDim:
    name: str
    label: str
    type: str
    default: float
    min: float | None = None
    max: float | None = None
    step: float | None = None
    unit: str = ""
    options: tuple[CommandOption, ...] = ()
    hotkeys: Mapping[str, str] = field(default_factory=dict)

    def min_value(self) -> float:
        if self.min is not None:
            return self.min
        if self.options:
            return min(option.value for option in self.options)
        return min(0.0, self.default)

    def max_value(self) -> float:
        if self.max is not None:
            return self.max
        if self.options:
            return max(option.value for option in self.options)
        return max(0.0, self.default)

    def to_json(self) -> dict:
        payload = {
            "name": self.name,
            "label": self.label,
            "type": self.type,
            "default": self.default,
            "min": self.min_value(),
            "max": self.max_value(),
            "unit": self.unit,
            "hotkeys": dict(self.hotkeys),
        }
        if self.step is not None:
            payload["step"] = self.step
        if self.options:
            payload["options"] = [option.to_json() for option in self.options]
        return payload


@dataclass(frozen=True)
class CommandSchema:
    title: str
    dims: tuple[CommandDim, ...]

    def default_vector(self) -> np.ndarray:
        return np.asarray([dim.default for dim in self.dims], dtype=np.float64)

    def min_vector(self) -> np.ndarray:
        return np.asarray([dim.min_value() for dim in self.dims], dtype=np.float64)

    def max_vector(self) -> np.ndarray:
        return np.asarray([dim.max_value() for dim in self.dims], dtype=np.float64)

    def to_json(self) -> dict:
        return {
            "title": self.title,
            "dims": [dim.to_json() for dim in self.dims],
        }


def load_command_schema(policy_yaml_path: Path, policy: BasePolicy) -> CommandSchema:
    schema_path = _resolve_schema_path(policy_yaml_path.parent)
    if schema_path.exists():
        schema = _load_configured_schema(schema_path)
    else:
        schema = _fallback_velocity_schema(policy, schema_path)

    _validate_schema(schema, schema_path)
    runtime_dim = _runtime_command_dim(policy)
    if len(schema.dims) != runtime_dim:
        raise ValueError(
            f"{schema_path} defines {len(schema.dims)} command dims, "
            f"but policy runtime_command_dim is {runtime_dim}"
        )
    return schema


def _resolve_schema_path(policy_dir: Path) -> Path:
    preferred = policy_dir / "web_policy.yaml"
    if preferred.exists():
        return preferred
    legacy = policy_dir / "web_demo.yaml"
    if legacy.exists():
        return legacy
    return preferred


def check_command_schema_compatibility(schemas: Mapping[str, CommandSchema]) -> None:
    first_name, first_schema = next(iter(schemas.items()))
    first_dim_names = [dim.name for dim in first_schema.dims]
    for name, schema in schemas.items():
        dim_names = [dim.name for dim in schema.dims]
        if dim_names != first_dim_names:
            raise ValueError(
                "all switchable policy-web-viewer command schemas must use compatible dim names; "
                f"{name!r} has {dim_names}, {first_name!r} has {first_dim_names}"
            )


def _load_configured_schema(schema_path: Path) -> CommandSchema:
    config = load_yaml(schema_path)
    command_config = config.get("command")
    if not isinstance(command_config, dict):
        raise TypeError(f"{schema_path} must define a 'command' mapping")

    title = str(command_config.get("title", "Command"))
    dims_config = command_config.get("dims")
    if not isinstance(dims_config, list) or not dims_config:
        raise ValueError(f"{schema_path} command.dims must be a non-empty list")

    return CommandSchema(
        title=title,
        dims=tuple(_parse_dim(schema_path, index, dim_config) for index, dim_config in enumerate(dims_config)),
    )


def _parse_dim(schema_path: Path, index: int, config) -> CommandDim:
    if not isinstance(config, dict):
        raise TypeError(f"{schema_path} command.dims[{index}] must be a mapping")

    dim_type = str(config.get("type", "slider"))
    options = _parse_options(schema_path, index, config.get("options", ()))
    if dim_type == "select" and not options:
        raise ValueError(f"{schema_path} command.dims[{index}] type 'select' requires options")

    min_value = _optional_float(config.get("min"))
    max_value = _optional_float(config.get("max"))
    if dim_type == "slider" and (min_value is None or max_value is None):
        raise ValueError(f"{schema_path} command.dims[{index}] type 'slider' requires min and max")

    default = _float(config.get("default", options[0].value if options else 0.0), "default")
    if dim_type == "toggle":
        min_value = _optional_float(config.get("off_value", min_value if min_value is not None else 0.0))
        max_value = _optional_float(config.get("on_value", max_value if max_value is not None else 1.0))

    hotkeys = config.get("hotkeys", {})
    if hotkeys is None:
        hotkeys = {}
    if not isinstance(hotkeys, dict):
        raise TypeError(f"{schema_path} command.dims[{index}].hotkeys must be a mapping")

    return CommandDim(
        name=str(config.get("name", f"command_{index}")),
        label=str(config.get("label", config.get("name", f"Command {index + 1}"))),
        type=dim_type,
        default=default,
        min=min_value,
        max=max_value,
        step=_optional_float(config.get("step")),
        unit=str(config.get("unit", "")),
        options=options,
        hotkeys={str(key): str(value) for key, value in hotkeys.items()},
    )


def _parse_options(schema_path: Path, dim_index: int, config) -> tuple[CommandOption, ...]:
    if config in (None, ()):
        return ()
    if not isinstance(config, list):
        raise TypeError(f"{schema_path} command.dims[{dim_index}].options must be a list")
    options = []
    for option_index, option_config in enumerate(config):
        if not isinstance(option_config, dict):
            raise TypeError(
                f"{schema_path} command.dims[{dim_index}].options[{option_index}] must be a mapping"
            )
        value = _float(option_config.get("value"), "value")
        options.append(CommandOption(label=str(option_config.get("label", value)), value=value))
    return tuple(options)


def _fallback_velocity_schema(policy: BasePolicy, schema_path: Path) -> CommandSchema:
    command_range = _velocity_command_range(policy)
    if command_range is None:
        raise FileNotFoundError(
            f"{schema_path} is required because this policy command cannot be inferred "
            "as the default 3D velocity command"
        )

    dims = []
    for (name, label, unit, positive, negative), (min_value, max_value) in zip(
        DEFAULT_VELOCITY_DIMS,
        command_range,
        strict=True,
    ):
        dims.append(
            CommandDim(
                name=name,
                label=label,
                type="slider",
                min=float(min_value),
                max=float(max_value),
                step=0.01,
                default=float(np.clip(0.0, min_value, max_value)),
                unit=unit,
                hotkeys={"positive": positive, "negative": negative},
            )
        )
    return CommandSchema(title="Velocity Command", dims=tuple(dims))


def _velocity_command_range(policy: BasePolicy) -> np.ndarray | None:
    for observation_spec in policy.config.get("observations", ()):
        if observation_spec.get("type") != "command":
            continue
        command_range = np.asarray(observation_spec.get("command_range"), dtype=np.float64)
        if command_range.shape == (3, 2):
            return command_range
        return None
    return None


def _runtime_command_dim(policy: BasePolicy) -> int:
    runtime_command_dim = policy.config.get("runtime_command_dim")
    if runtime_command_dim is not None:
        return int(runtime_command_dim)
    command_range = _velocity_command_range(policy)
    if command_range is not None:
        return int(command_range.shape[0])
    raise KeyError("policy.yaml must define runtime_command_dim or a 3D command observation range")


def _validate_schema(schema: CommandSchema, schema_path: Path) -> None:
    if not schema.dims:
        raise ValueError(f"{schema_path} command schema must define at least one dim")

    seen_names: set[str] = set()
    for index, dim in enumerate(schema.dims):
        if not dim.name:
            raise ValueError(f"{schema_path} command.dims[{index}].name must be non-empty")
        if dim.name in seen_names:
            raise ValueError(f"{schema_path} command dim name {dim.name!r} is duplicated")
        seen_names.add(dim.name)
        if dim.type not in SUPPORTED_COMMAND_TYPES:
            known = ", ".join(sorted(SUPPORTED_COMMAND_TYPES))
            raise ValueError(f"{schema_path} command dim {dim.name!r} has unsupported type {dim.type!r}; known: {known}")
        min_value = dim.min_value()
        max_value = dim.max_value()
        if min_value > max_value:
            raise ValueError(f"{schema_path} command dim {dim.name!r} has min > max")
        if not min_value <= dim.default <= max_value:
            raise ValueError(
                f"{schema_path} command dim {dim.name!r} default {dim.default} "
                f"is outside [{min_value}, {max_value}]"
            )


def _optional_float(value) -> float | None:
    if value is None:
        return None
    return _float(value, "value")


def _float(value, label: str) -> float:
    if value is None:
        raise ValueError(f"{label} is required")
    return float(value)
