# Flow Fields 3D

Traces streamlines through three-dimensional vector fields and extrudes them
into shaded ribbons, tubes or lines. It is the spatial counterpart to
[FlowFieldsPlotter](https://snicker02.github.io/FlowFieldsPlotter/) — the same
even-spacing, seeding and pen-layer ideas, applied to fields that curl through
a volume instead of across a page.

WebGL1, ES modules, no dependencies, no build step.

## Running it

Because it uses ES modules, opening `index.html` from the filesystem will not
work — browsers refuse module loads over `file://`. Serve the folder:

```sh
python3 -m http.server 8000     # or: npm run serve
```

then open `http://localhost:8000`. On GitHub Pages it works as-is: push the
repo, enable Pages on the branch root, done.

## The pipeline

```
analytic vector field
  → symmetry fold, domain warp, second-field blend, swirl and drift
  → RK4 unit-speed integration (optionally evenly spaced)
  → auto-fit into the unit ball
  → rotation-minimising frames
  → ribbon / tube / line extrusion, coloured per sample
  → chunked 16-bit draw calls
```

Integration is **unit-speed**: the step is a distance along the curve rather
than a step in time, so samples come out evenly spaced no matter how fast the
field runs there. That is exactly what extrusion wants, and it is why fast and
slow regions get the same ribbon quality. The raw speed is kept per sample for
colour and width.

Frames come from the double-reflection method (Wang et al. 2008), not from
Frenet frames. Frenet frames flip 180° through an inflection point, which puts
a visible crease in a ribbon; rotation-minimising frames do not.

After tracing, everything is fitted into the unit ball. That is why the Lorenz
attractor (span ≈ 60) and the gyroid (span ≈ 1) can share one camera, one set
of light settings and one ribbon width.

## Fields

22 of them, each with its own parameters:

| Group | Fields |
| --- | --- |
| Noise | Curl noise, Curl noise on shells |
| Analytic | ABC flow, Taylor–Green vortex, Helical shear, Double gyre |
| Attractor | Lorenz, Rössler, Thomas, Aizawa, Halvorsen, Dadras, Chen–Lee, Sprott linz-F, Four-wing |
| Topology | Hopf fibration, Vortex filaments, Spherical harmonic swirl, Inversive swirl |
| Physical | Magnetic dipoles, Orbital wells |
| Lattice | Minimal-surface flow (gyroid, Schwarz P, diamond, Neovius) |

Curl noise is the curl of an fBm vector potential, so it is divergence free and
streamlines neither bunch up nor thin out. Vortex filaments evaluate a
regularised Biot–Savart integral over rings, torus knots, helices, linked rings
or a random tangle — it is the slowest field here and the one worth the wait.

A second field can be mixed in by interpolation, addition or **cross product**;
the cross product makes streamlines run along the intersection of the two
flows, which is where a lot of the weaving comes from.

Ten symmetry modes fold the domain — mirror, octant, octahedral, tetrahedral,
3/5/6-fold rotation, sphere inversion. Folds accumulate an orthogonal matrix and
map the velocity back through its transpose, so a folded field is genuinely
equivariant rather than just mirrored-looking.

## Controls

Drag to orbit, wheel to zoom, shift-drag or right-drag to pan, pinch on touch.

| Key | |
| --- | --- |
| `R` | retrace |
| `Space` | shuffle (new seed and a nudge to the parameters) |
| `H` | hide the panel |
| `P` | save a PNG |

The panel is grouped as Field, Second field, Streamlines, Ribbons, Colour,
Light and air, Motion and camera. Ribbons offer 7 width modes and 9 colour
modes (along the curve, per curve, speed, curvature, height, depth, radius,
direction, random), driven by a gradient you can edit — drag stops, click to
add, double-click to remove, or start from one of 10 presets.

Work is split into three levels so the app only redoes what changed: **draw**
(uniforms only), **geom** (re-extrude the same curves), **trace** (re-integrate).
Tracing runs in time slices from the animation loop, so the UI stays live and
you get a progress bar. While a slider is being dragged the tracer drops to a
draft budget and snaps back on release.

The flow animation is a travelling highlight computed in the fragment shader, so
it costs nothing per frame and never re-traces.

## Export

- **PNG** — supersampled, through the same render path as the screen
- **SVG** — projected vector output with painter ordering, perspective stroke
  width, depth fade, and colour-quantised pen layers carrying `inkscape:label`
- **OBJ** — the extruded mesh
- **JSON** — the full state, to reload later

SVG and the shaded view are generated from the same prepared-curve stage, so
they cannot disagree about what is on screen.

## Checks

```sh
npm run check      # or: bash tools/check.sh
```

Three gates:

1. every source file parses, including the DOM-only ones
2. `tools/test.mjs` — 2400+ assertions with no browser: divergence of the curl
   noise, RK4 convergence order, equivariance of the symmetry folds,
   orthonormality of the frames, spatial hash against brute force, index bounds
   and chunking for every geometry × colour mode, SVG well-formedness, and every
   preset run end to end through the real pipeline
3. `tools/glsl.py` — compiles and links the shaders on a headless OpenGL ES 2.0
   context, which is the same profile WebGL1 exposes. Needs `pip install
   PyOpenGL` and Mesa; skipped with a note if they are missing. A deliberately
   broken shader is included, and the run fails if the driver accepts it.

## Performance

Trace times on a slow headless CPU, at full preset budgets: most land between
0.1 and 3.5 seconds, with vortex filaments the outlier because Biot–Savart is
O(curves × samples × segments). Geometry rebuilds are 0.1–0.9 s. If you push the
curve count and step count up, the numbers scale about linearly; the progress
bar will tell you what you have asked for.

Memory is the other budget. A tube at 6 sides costs six vertices per sample, and
vertices carry position, normal, colour and parameters. Around 3 million
vertices is where an ordinary GPU starts to complain — the status bar reports
the count.
