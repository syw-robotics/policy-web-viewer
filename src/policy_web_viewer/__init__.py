"""Browser-based policy demo without Unitree DDS."""

from __future__ import annotations

import os


# The web demo renders MuJoCo offscreen. EGL is the least surprising default on
# Linux servers and SSH sessions; users can still override it with MUJOCO_GL.
os.environ.setdefault("MUJOCO_GL", "egl")
