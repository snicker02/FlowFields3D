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

## Fractalize

Two different senses of the word, on separate controls, usable together.

**Fold** applies an iterated map to the sample point before the field is read:
Amazing Box, Sierpinski, Menger cross, kaleidoscopic IFS, or an Apollonian
lattice-and-inversion. Every operation used is a *similarity* — reflection,
rotation, uniform scale, sphere inversion — so the Jacobian of the whole fold is
a scaled orthogonal matrix, and the velocity pulls back exactly as `Mᵀv`. That
matters: it means a streamline traced in world space is the exact preimage of a
streamline of the unfolded field, rather than something that merely looks
folded. The tests check this directly, by stepping the world point along `Mᵀu`
and confirming the folded point moves along `u` (worst case 1 − cos ≈ 3e-10).

Every fold is also continuous — box folds reflect at the plane they test, sphere
folds match from both sides — so streamlines bend at fold surfaces but never
jump. The fixed iteration count is what buys that; escape-time iteration would
tear the field along the escape boundary.

One deliberate deviation: a true Mandelbox adds the *original* point each
iteration, which makes the Jacobian `s·J + I` — not a similarity, and the clean
pullback is lost. This uses a constant offset instead, the Amazing Box form.

Raising iterations or fold scale puts the structure at `scale^iterations` of its
usual size, so the step size is divided by the same factor automatically
(capped at 16×). Without that, turning up "iterations" makes the picture worse
rather than finer — the tracer strides straight past the detail it just created.
Expect shorter streamlines from the fold presets: folding brings distant curves
into the same neighbourhood, so the even-spacing test retires them sooner.

**Octaves** sums the field over self-similar scales instead,
`v(p) = Σ aⁱ Rᵢᵀ f(bⁱ Rᵢ p)`. Each term is a rotated, scaled pullback, so a
divergence-free field stays divergence free — verified against ABC flow, whose
divergence is analytically zero. It costs one field evaluation per octave, which
on curl noise is the most expensive thing in the app.

## Controls

Drag to orbit, wheel to zoom, shift-drag or right-drag to pan, pinch on touch.

| Key | |
| --- | --- |
| `R` | retrace |
| `Space` | shuffle (new seed and a nudge to the parameters) |
| `H` | hide the panel |
| `P` | save a PNG |

The panel is grouped as Field, Fractal, Second field, Streamlines, Ribbons,
Colour, Light and air, Motion and camera. Ribbons offer 7 width modes and 9 colour
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

## Materials and texture

Three materials. **Satin** is the original hemisphere-ambient shading.
**Mirror** reflects the view vector into the same sky/ground environment the
ambient term already uses, tinted by the ribbon colour, with a Fresnel-weighted
falloff to raw environment at grazing angles. **Glass** keeps a dimmed
transmitted term, adds the environment weighted by Fresnel, and drives its own
alpha from the same term so faces are transparent and edges are not.

There is no cube map and no scene sampling — a WebGL1 single pass has neither.
The environment is analytic, which is why it costs nothing and why it will not
show you one ribbon reflected in another. The reflection is taken back into
world space (by multiplying the reflection vector on the *right* by the normal
matrix, which transposes it) so the mirror stays put while you orbit, rather
than sliding around like a matcap.

Glass is blended without sorting the geometry, so the ordering is approximate.
Depth writes are off, which is what keeps that from looking obviously wrong.

Seven procedural textures — cross bands, lengthwise stripes, checker, weave,
dots, grain, diagonal hatch — with controls for repeats along and across,
depth, and edge softness. They need a coordinate across the form as well as
along it, so vertices now carry three parameters instead of two: arclength, a
per-curve random, and an edge-to-edge coordinate that also wraps a tube or box.
The per-curve random offsets each pattern so neighbouring ribbons do not line up
into one sheet.

Every pattern is built from sines and `smoothstep` rather than `step` and
`fwidth`. Derivatives need `GL_OES_standard_derivatives`, which WebGL1 does not
promise, and a hard step on a ribbon a few pixels wide aliases into noise.

## Export

- **PNG** — at any size up to 300 megapixels, through the same render path as
  the screen. Sizes include 4K through 12K, square 4096/8192, A3, A2 and
  16 x 20in at 300 dpi, plus a custom width and height. Anything larger than one
  tile is rendered in pieces and composited, because a 12K frame is 75
  megapixels before supersampling and no WebGL context will hand that over in
  one buffer. Each tile is drawn through its own slice of the *same* frustum, so
  the camera never moves between them and the seams are exact. The background
  gradient and vignette are told which part of the picture they are covering, or
  they would restart in every tile. Supersampling (1-4x) is applied on top and
  resolved per tile.
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
   noise, RK4 convergence order, equivariance of the symmetry and fractal
   folds,
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

Big exports are the other place to be careful: 12K at 4x supersample renders
1.2 billion pixels of geometry and takes a while, with a progress bar per tile.
The status line reports the finished file size.

Memory is the other budget. A tube at 6 sides costs six vertices per sample, and
vertices carry position, normal, colour and parameters. Around 3 million
vertices is where an ordinary GPU starts to complain — the status bar reports
the count.
