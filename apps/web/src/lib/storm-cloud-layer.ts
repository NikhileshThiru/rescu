import { BitmapLayer, type BitmapLayerProps } from "@deck.gl/layers";

/**
 * The hurricane itself, drawn procedurally on the GPU: a dense central overcast with a clear eye
 * and bright eyewall, and rain bands that wind out from it. Cloud texture is fractal noise sampled
 * in spiral-warped space, so it streaks along the bands and drifts inward along them while the
 * whole storm turns counter-clockwise. Nothing is recomputed on the CPU per frame: the layer just
 * passes a few numbers (spin, time, strength, eye and core size) to the shader.
 */
export interface CloudParams {
  /** Seconds of real time, drives the inflow drift of the cloud texture. */
  time: number;
  /** Rotation of the storm (radians, counter-clockwise). */
  spin: number;
  /** 0 (weak, ragged, no eye) .. 1 (major hurricane). */
  strength: number;
  /** Eye radius as a fraction of the drawn radius. */
  eye: number;
  /** Central dense overcast radius as a fraction of the drawn radius. */
  core: number;
  /** Per-storm variation of the cloud pattern. */
  seed: number;
  opacity: number;
}

const block = /* glsl */ `\
layout(std140) uniform cloudUniforms {
  float time;
  float spin;
  float strength;
  float eye;
  float core;
  float seed;
  float opacity;
} cloud;
`;

const cloudModule = {
  name: "cloud",
  vs: block,
  fs: block,
  uniformTypes: {
    time: "f32",
    spin: "f32",
    strength: "f32",
    eye: "f32",
    core: "f32",
    seed: "f32",
    opacity: "f32",
  },
} as const;

const fs = /* glsl */ `\
#version 300 es
#define SHADER_NAME storm-cloud-fragment-shader
precision highp float;

in vec2 vTexCoord;
in vec2 vTexPos;
out vec4 fragColor;

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i);
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z
  );
}

float fbm(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.07 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s / 0.96875;
}

// Three octaves: enough for the large-scale warp, which only bends the pattern.
float fbm3(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * vnoise(p);
    p = p * 2.07 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s / 0.875;
}

vec2 rotate(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

// Spiral tightness: bands satisfy theta + K ln r = const (they trail clockwise going outward,
// as a northern-hemisphere storm's do).
const float K = 1.9;
const float ARMS = 3.0;

void main(void) {
  // North-up coordinates, 0 at the eye, 1 at the drawn radius.
  vec2 p = vec2(vTexCoord.x * 2.0 - 1.0, 1.0 - vTexCoord.y * 2.0);
  float r = length(p);
  if (r > 1.0) discard;
  float lr = log(max(r, 0.012));
  float a = atan(p.y, p.x) + K * lr - cloud.spin;

  // Band texture: noise on a cylinder (seamless in angle), stretched along the arms, flowing in.
  vec3 q = vec3(cos(a) * 1.6, sin(a) * 1.6, lr * 1.35 + cloud.time * 0.045 + cloud.seed);
  float warp = fbm3(q * 1.3 + 4.0);
  float n = fbm(q * 1.8 + warp * 0.9);
  // Cloud-top texture turning with the storm, and cumulus grain for close-ups.
  vec2 pr = rotate(p, -cloud.spin * 0.85);
  float fine = fbm(vec3(pr * 9.0 + warp * 1.5, cloud.seed * 3.1 + cloud.time * 0.02));
  float grain = vnoise(vec3(pr * 42.0, cloud.time * 0.05));

  float organised = mix(0.45, 1.0, cloud.strength);
  float core = cloud.core * (0.9 + 0.24 * (n - 0.5));

  float phase = ARMS * a + (n - 0.5) * mix(4.5, 2.4, cloud.strength);
  float band = pow(0.5 + 0.5 * cos(phase), mix(1.6, 2.8, cloud.strength));
  // One principal band dominates, as in real storms.
  float principal = 0.72 + 0.28 * cos(a + cloud.seed);
  float bandEnv = smoothstep(1.0, 0.35, r) * smoothstep(core * 0.55, core * 1.2, r);
  float bands = band * bandEnv * principal * (0.5 + 0.75 * n) * organised;

  float cdo = (1.0 - smoothstep(core * 0.65, core * 1.3, r)) * (0.75 + 0.35 * n);
  // Thin cirrus outflow veil over the whole storm.
  float haze = 0.24 * smoothstep(1.0, 0.25, r) * fine;
  float d = max(max(cdo, bands), haze);
  d *= 0.52 + 0.62 * fine;
  d *= 0.86 + 0.28 * grain;

  // Eye and eyewall, only once the storm is organised enough to have one.
  float hasEye = smoothstep(0.35, 0.7, cloud.strength);
  float e = cloud.eye;
  float eyeMask = smoothstep(e * 0.75, e * 1.15, r + (fine - 0.5) * e * 0.35);
  float wall = exp(-pow((r - e * 1.4) / (e * 0.55 + 0.004), 2.0)) * hasEye;
  d = mix(d, d * eyeMask, hasEye) + wall * 0.45;

  // Soft outer edge, broken up by the band noise.
  d *= 1.0 - smoothstep(0.62 + 0.25 * n, 1.0, r);

  float alpha = smoothstep(0.08, 0.8, d);
  float lit = clamp(smoothstep(0.2, 1.0, d) * (0.74 + 0.34 * fine), 0.0, 1.0);
  vec3 color = mix(vec3(0.42, 0.49, 0.62), vec3(0.93, 0.95, 0.99), lit);
  color = mix(color, vec3(1.0), wall * 0.35);

  fragColor = vec4(color, alpha * cloud.opacity * layer.opacity);
  geometry.uv = vTexCoord;
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

type Props = BitmapLayerProps & { cloud: CloudParams };

export class StormCloudLayer extends BitmapLayer<{ cloud: CloudParams }> {
  static layerName = "StormCloudLayer";

  getShaders() {
    const shaders = super.getShaders();
    return { ...shaders, fs, modules: [...shaders.modules, cloudModule] };
  }

  draw() {
    const { model, coordinateConversion, bounds } = this.state as {
      model?: { shaderInputs: { setProps: (p: object) => void }; draw: (pass: unknown) => void };
      coordinateConversion: number;
      bounds: number[];
    };
    if (!model) return;
    model.shaderInputs.setProps({
      bitmap: { bounds, coordinateConversion, desaturate: 0, tintColor: [1, 1, 1], transparentColor: [0, 0, 0, 0] },
      cloud: (this.props as Props).cloud,
    });
    model.draw(this.context.renderPass);
  }
}
