# Walking Speed of Light

A special relativity simulator in which **c = 5 km/h**.

Light crawls along at a brisk walk, so you can outrun it. Break into a jog and the
park in front of you crowds together and turns violet, the park behind you reddens
and falls away into a shrinking disc, and your watch starts losing time against
every clock around you. All the effects that normally need a particle accelerator
happen at a pace you can feel in your legs.

No dependencies, no build step. Open `index.html`.

```
node tools/serve.mjs        # http://localhost:8123
node tools/bundle.mjs       # dist/index.html — one self-contained file
```

## What it actually computes

Each vertex is asked one question: *light arriving at my eye right now, from this
piece of the world — where did it come from, and what happened on the way?*

1. **Retarded time.** Walk back down the past light cone to find when the light
   left. For static scenery that is `distance / c`. For the moving props it is a
   six-step Newton solve of `|p(t − a) − eye| = c·a`, which converges quadratically
   because `dg/da = 1 + (v·n̂)/c` never reaches zero while `|v| < c`.

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

Objects fade to black at extreme speed for an honest reason — the sun has no light
left to give at the wavelengths you would need to be receiving.

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
- **The ground gets its own budget.** It is the surface the transform punishes
  hardest — a flat plane of straight edges that the boost bends into curves, where
  the faceting error goes as the square of the angular step. It is a polar disc
  graded exponentially from 1.2 m to 4 km, tessellated so the quads stay square
  (the radial step used to be 1.8x the tangential one, and that was where the
  facets came from). `Ground detail` in Settings swaps the mesh live, from 33k
  vertices at Low to 474k at Very high.
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

## Controls

`W A S D` or arrows walk · mouse looks · `Shift` sprints · `Space` brakes (nothing
else slows you — you coast) ·
`Q`/`E` drop and rise · `G` toggles relativity off and back on · `R` resets ·
`Tab` settings · `H` field guide.

## Layout

```
index.html        page and instrument chrome
css/style.css
js/glutil.js      WebGL2 helpers
js/color.js       CIE colour matching, Doppler LUT
js/geometry.js    tessellated mesh builders
js/shaders.js     the relativistic vertex transform
js/scene.js       the park
js/app.js         controls, dynamics, render loop
tools/serve.mjs   dev server
tools/bundle.mjs  inlines everything into dist/
```

Requires WebGL 2.
