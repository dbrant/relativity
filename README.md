# Walking Speed of Light

A special relativity simulator in which **c = 5 km/h**.

Light crawls along at a brisk walk, so you can outrun it. Break into a jog and the
park in front of you crowds together and turns violet, the park behind you reddens
and falls away into a shrinking disc, and your watch starts losing time against
every clock around you. All the effects that normally need a particle accelerator
happen at a pace you can feel in your legs.

No dependencies, no build step. Open `index.html`.

```
node tools/serve.mjs         # http://localhost:8123
node tools/bundle.mjs        # dist/index.html — one self-contained file
node tools/embed-models.mjs  # after adding or changing an STL
```

## What it actually computes

Each vertex is asked one question: *light arriving at my eye right now, from this
piece of the world — where did it come from, and what happened on the way?*

1. **Retarded time.** Walk back down the past light cone to find when the light
   left. For static scenery that is `distance / c`. For the moving props it means
   solving `g(a) = a − |p(t − a) − eye| / c = 0`, and doing it carefully:
   `g'(a) = 1 + (v·n̂)/c` never reaches zero while `|v| < c`, but it gets to 0.14
   at the corners of a carousel car, which travel at 0.857c. Plain Newton then
   flings the iterate most of the way around the orbit, and since every vertex
   solves independently, neighbours land on different revolutions and tear
   triangles across the scene. Every point of a mover stays within a known radius
   of its reference, so the delay is bracketed, `g` is monotonic, and bisection
   cannot fail; Newton is accepted only when it lands inside the bracket. 24
   iterations, worst error 0.06 px.

2. **The boost.** Take the null 4-vector from that emission event to the eye and
   Lorentz-transform it into the observer's instantaneous rest frame. Everything
   visual falls out of this single step — aberration, Lorentz contraction, and
   Terrell rotation, which is not really a rotation at all but what light delay
   does to an already-contracted object.

3. **Doppler.** The boost rescales the null vector, and that ratio *is* the Doppler
   factor `D = γ(1 + β·r̂)`. No second formula.

Colour is done properly rather than as a hue rotation. Each surface colour is
modelled as a spectral reflectance — a Gaussian lobe over a broad neutral floor —
lit by a 5800 K solar illuminant, shifted by `D`, and re-integrated against the
CIE 1931 colour matching functions (Wyman–Sloan–Shirley analytic fits). Because
that whole chain is linear in the three primary weights, the effect at any `D`
collapses to one 3×3 matrix, tabulated over log `D` and handed to the GPU. It is
normalised so `D = 1` is exactly the identity: at rest, nothing is touched.

Redshift ends in black, honestly: the beaming factor is shrinking too, and there
is nothing to see out in the radio.

Blueshift is where the naive integral misleads. Run it straight and the view goes
violet, then magenta, then black — the visible band is sampling ever deeper into
the source's infrared, and there is little out there. True of the eye, and a poor
picture of what is happening. At `D = 12` only **0.5%** of the arriving power is
still visible; the source's own visible light is landing as X-rays and gamma, and
anything looking at it is being flooded, not starved. So once the visible band
stops carrying the energy, the response saturates to white instead of fading. The
weight is the share of received power that has left the visible band, shaped by an
exponent so that ordinary blueshift keeps its blue and only the extreme end washes
out. That one is a choice, and it is the only one in the colour path.

Brightness uses the bolometric `D⁴` beaming law. Because that clips to white at
even a jog, there is an eye-adaptation model on by default: the log-average
beaming factor across the field of view, chased with a 0.3 s time constant. It
moves the overall level only; the front-to-back gradient within the frame is
untouched. Turn it off in Settings to see the raw law.

Your own motion integrates through Einstein velocity addition, so holding the key
down adds *rapidity* linearly and you approach `c` without ever arriving — the
velocity readout carries five decimals so you can watch 4.99995 km/h refuse to
become 5. There is no drag term: release the keys and you coast.

## Deliberate choices

- **Everything is heavily tessellated** (~275k vertices by default). The transform
  is applied per vertex and is strongly non-linear, so straight edges genuinely
  bend. A cube drawn with eight vertices would still look like a cube at 0.9c,
  which is a lie.
- **The ground gets its own budget, and it moves.** It is the surface the
  transform punishes hardest — a flat plane of straight edges that the boost
  bends into curves, where the faceting error goes as the square of the angular
  step. It is a polar disc graded exponentially from 1.2 m to 4 km, tessellated
  so the quads stay square.

  The disc is not scenery, it is a tessellation carrier: its grid and mottle are
  computed from world coordinates in the fragment shader, so the mesh can slide
  along with the eye without anything visibly moving. It does exactly that, which
  keeps the finest rings underfoot however far you have walked. Anchored at the
  origin it did not — 500 m out, the spacing beneath you was 7.8 m.

- **Tessellation follows γ.** The angular magnification of aberration is exactly
  `1/D`. Forward that is a compression, so the view ahead needs *less* geometry
  than at rest; astern it is a magnification of `γ(1+β)`, and that is where
  straight edges bend hardest. So the ground steps up a ladder as you accelerate
  — 33k vertices at Low through 650k at Extreme — with two steps of headroom
  above whatever floor you set, and hysteresis on the thresholds so a wobble
  cannot thrash it. Levels are built once and kept, because rebuilding a 650k
  disc mid-acceleration is exactly when a hitch would show.
- **Backface culling is off.** Terrell rotation shows you faces that are pointing
  away from you; culling them would delete the effect.
- **Logarithmic depth.** The apparent scene spans centimetres to tens of
  kilometres once `γ(1+β)` stretches the world ahead.
- **Real time is your proper time.** Your wristwatch ticks with the animation
  frame; the world's clock is the one that runs fast, by exactly `γ`.

## The park

| | |
|---|---|
| the colonnade | the classic corridor; aberration bends it into a tunnel |
| paired staves | two identical 60 m surveyor's staves, one along Z and one along X — run down the corridor and only one of them shortens |
| the arches | closed loops, so you can watch a circle become an ellipse |
| the beacons | all flash once per second of *world* time; their apparent rate is a Doppler readout you can count |
| the carousel | cars contracted by their own motion, each seen at a different retarded moment; the receding half is beamed nearly to black |
| the shuttle | slides along X, so its contraction breathes in and out as it goes |
| two sculptures | STL models on plinths, flanking the colonnade |

## STL models

Drop an `.stl` into `objects/` (binary or ASCII), add an entry to `MODELS` in
`js/scene.js`, and run `node tools/embed-models.mjs`. Three things happen to it
that a plain STL viewer would not bother with:

- **Weld.** STL stores each triangle's corners independently, so a closed model
  arrives as loose facets. Welding by position gives an indexed mesh and lets
  facet normals be averaged into smooth shading — area-weighted, so slivers do
  not sway the average.
- **Subdivide.** The transform is per vertex and bends straight edges into
  curves, so a long edge is drawn as a chord of the curve it should be. Splitting
  is uniform 4-way through a shared midpoint cache, so neighbours split
  identically and no T-junctions open up at speed. It repeats while the longest
  edge exceeds 22 cm, under a 60k-triangle budget so a coarse model cannot run
  away. The bunny lands at 13,934 vertices, one level in.
- **Fit.** STL carries no units and no agreed up-axis. Blender writes Z-up and
  these arrive about 86 units tall, so a model is rotated to Y-up, scaled to a
  height in metres, centred, and stood on its plinth.

Models are also baked into `objects/models.js` as base64, because the page is
meant to open straight off the filesystem and `file://` forbids `fetch`. The
fetch path stays as a fallback, so a new STL appears on a served page without
rebuilding. That generated file is committed for the same reason `dist/` is: so a
fresh clone works by double-clicking. It is what makes the page 1.2 MB.

Loading is asynchronous and failure is survivable: a missing or malformed STL
costs a console warning, and the park stands up without it.

## Controls

`W A S D` or arrows walk · mouse looks · `Space` brakes (nothing else slows you —
you coast) · `Q`/`E` drop and rise · `R` resets · `Tab` settings · `H` field guide.

One key per effect, so you can take them away singly and see which part of the
picture each one was responsible for: `L` light-travel delay, `G` aberration and
contraction, `C` Doppler colour, `B` relativistic beaming.

## Layout

```
index.html        page and instrument chrome
css/style.css
js/glutil.js      WebGL2 helpers
js/color.js       CIE colour matching, Doppler LUT
js/geometry.js    tessellated mesh builders
js/stl.js         STL loading: weld, subdivide, auto-fit
js/shaders.js     the relativistic vertex transform
js/scene.js       the park
js/app.js         controls, dynamics, render loop
objects/          STL models, plus the generated models.js
tools/serve.mjs   dev server
tools/bundle.mjs  inlines everything into dist/
tools/embed-models.mjs   bakes objects/*.stl to base64
```

Requires WebGL 2.
