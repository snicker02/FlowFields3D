#!/usr/bin/env python3
"""Compile and link every shader against a real OpenGL ES 2.0 driver.

WebGL1 is GL ES 2.0, so a headless Mesa/llvmpipe context accepts exactly what a
browser would. Run tools/dump-shaders.mjs first; this reads tools/shaders.json.

    node tools/dump-shaders.mjs && python3 tools/glsl.py

Needs PyOpenGL and Mesa:  pip install PyOpenGL
"""

import json
import os
import sys
from pathlib import Path

os.environ.setdefault("LIBGL_ALWAYS_SOFTWARE", "1")
os.environ.setdefault("EGL_PLATFORM", "surfaceless")

from OpenGL.EGL import (  # noqa: E402
    EGL_DEFAULT_DISPLAY, EGL_NONE, EGL_NO_CONTEXT, EGL_NO_SURFACE,
    EGL_OPENGL_ES_API, EGL_OPENGL_ES2_BIT, EGL_PBUFFER_BIT,
    EGL_RENDERABLE_TYPE, EGL_SURFACE_TYPE, EGL_CONTEXT_CLIENT_VERSION,
    EGLConfig, EGLint, eglBindAPI, eglChooseConfig, eglCreateContext,
    eglGetDisplay, eglInitialize, eglMakeCurrent,
)
from OpenGL import GLES2 as gl  # noqa: E402


def make_context():
    display = eglGetDisplay(EGL_DEFAULT_DISPLAY)
    major, minor = EGLint(), EGLint()
    if not eglInitialize(display, major, minor):
        sys.exit("Could not initialise EGL. Is Mesa installed?")
    eglBindAPI(EGL_OPENGL_ES_API)
    attribs = (EGLint * 5)(
        EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
        EGL_NONE,
    )
    configs = (EGLConfig * 1)()
    count = EGLint()
    if not eglChooseConfig(display, attribs, configs, 1, count) or count.value == 0:
        sys.exit("No EGL config with an ES2 renderable was available.")
    ctx_attribs = (EGLint * 3)(EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE)
    context = eglCreateContext(display, configs[0], EGL_NO_CONTEXT, ctx_attribs)
    if not context:
        sys.exit("Could not create an ES2 context.")
    eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, context)


def as_text(value):
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


def compile_stage(kind, source, label, errors):
    shader = gl.glCreateShader(kind)
    gl.glShaderSource(shader, source)
    gl.glCompileShader(shader)
    if gl.glGetShaderiv(shader, gl.GL_COMPILE_STATUS) != gl.GL_TRUE:
        errors.append(f"{label}:\n{as_text(gl.glGetShaderInfoLog(shader)).strip()}")
        return None
    log = as_text(gl.glGetShaderInfoLog(shader)).strip()
    if log:
        print(f"    note ({label}): {log}")
    return shader


def check(program):
    errors = []
    vs = compile_stage(gl.GL_VERTEX_SHADER, program["vertex"], "vertex shader", errors)
    fs = compile_stage(gl.GL_FRAGMENT_SHADER, program["fragment"], "fragment shader", errors)
    if vs is None or fs is None:
        return errors

    handle = gl.glCreateProgram()
    gl.glAttachShader(handle, vs)
    gl.glAttachShader(handle, fs)
    gl.glLinkProgram(handle)
    if gl.glGetProgramiv(handle, gl.GL_LINK_STATUS) != gl.GL_TRUE:
        errors.append("link:\n" + as_text(gl.glGetProgramInfoLog(handle)).strip())
    return errors


def main():
    path = Path(__file__).with_name("shaders.json")
    if not path.exists():
        sys.exit("tools/shaders.json is missing — run: node tools/dump-shaders.mjs")
    programs = json.loads(path.read_text())

    make_context()
    print("compiling against a headless OpenGL ES 2.0 context (the WebGL1 profile)\n")

    failed = 0
    for program in programs:
        name = program["name"]
        errors = check(program)
        expect_fail = program.get("expectFail", False)
        if expect_fail:
            if errors:
                print(f"  ok   {name} — rejected, as it should be")
            else:
                print(f"  FAIL {name} — the validator accepted a broken shader, so it is not testing anything")
                failed += 1
            continue
        if errors:
            failed += 1
            print(f"  FAIL {name}")
            for e in errors:
                print("    " + e.replace("\n", "\n    "))
        else:
            print(f"  ok   {name}")

    print("")
    if failed:
        print(f"{failed} shader program(s) failed")
        sys.exit(1)
    print("all shader programs compiled and linked")


if __name__ == "__main__":
    main()
