import * as THREE from 'three';

// VintageFX — a full-screen post-processing layer that turns the live 3D scene
// into a 1930s rubber-hose cartoon (Cuphead / Fleischer-reel look):
//
//   1. INK OUTLINES   depth-edge detection draws bold dark lines around shapes
//   2. CEL POSTERIZE  the image is quantised into flat colour bands
//   3. SEPIA GRADE    desaturated, warmed and tinted toward aged-film sepia
//   4. VIGNETTE       soft darkening at the frame edges
//   5. FILM GRAIN     animated speckle + faint emulsion flicker
//
// Implementation: render the scene once into an offscreen target that carries a
// DepthTexture, then draw a single fullscreen quad whose shader reads colour +
// depth and applies every effect in one pass. Cheap (one scene render + one
// quad) and avoids EffectComposer ping-pong/depth headaches.
export class VintageFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;

    const size = renderer.getSize(new THREE.Vector2());
    const pr = renderer.getPixelRatio();
    const w = Math.floor(size.x * pr), h = Math.floor(size.y * pr);

    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.type = THREE.UnsignedIntType;
    depthTexture.format = THREE.DepthFormat;

    this.target = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      depthTexture,
    });
    // Render the scene into the target already sRGB-encoded (display-ready), so
    // the raw fullscreen quad can sample and output it unchanged — no double
    // conversion / darkening.
    this.target.texture.colorSpace = THREE.SRGBColorSpace;

    // Style parameters — exposed for live tuning.
    // Painterly soft-toon look: thin warm outlines, near-smooth shading, gentle
    // warm grade, and atmospheric depth haze that fades distance into the horizon.
    this.params = {
      outlineThickness: 1.1,   // px scale of the depth-edge sampling
      outlineStrength: 0.42,   // soft, not heavy ink
      outlineThreshold: 0.24,  // only strong silhouettes get a line
      posterizeLevels: 24.0,   // high = near-smooth gradient shading
      sepiaStrength: 0.12,     // just a whisper of warmth
      grainStrength: 0.018,    // very subtle paper texture
      vignetteStrength: 0.18,  // soft edge falloff
      contrast: 1.03,
      brightness: 1.18,        // overall exposure lift
      saturation: 0.95,        // slightly muted, painterly (not garish)
      hazeStrength: 0.9,       // atmospheric perspective into the horizon
    };

    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.material = this.#buildMaterial(w, h);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  #buildMaterial(w, h) {
    const p = this.params;
    return new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse:       { value: this.target.texture },
        tDepth:         { value: this.target.depthTexture },
        cameraNear:     { value: this.camera.near },
        cameraFar:      { value: this.camera.far },
        resolution:     { value: new THREE.Vector2(w, h) },
        uTime:          { value: 0 },
        uInkColor:      { value: new THREE.Color(0x3a2c20) },
        uSepiaColor:    { value: new THREE.Color(0xffe7c8) },
        uHazeColor:     { value: new THREE.Color(0xe8cba6) },
        uOutlineThick:  { value: p.outlineThickness },
        uOutlineStr:    { value: p.outlineStrength },
        uOutlineThresh: { value: p.outlineThreshold },
        uLevels:        { value: p.posterizeLevels },
        uSepia:         { value: p.sepiaStrength },
        uGrain:         { value: p.grainStrength },
        uVignette:      { value: p.vignetteStrength },
        uContrast:      { value: p.contrast },
        uBrightness:    { value: p.brightness },
        uSaturation:    { value: p.saturation },
        uHaze:          { value: p.hazeStrength },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        #include <packing>
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform float cameraNear;
        uniform float cameraFar;
        uniform vec2  resolution;
        uniform float uTime;
        uniform vec3  uInkColor;
        uniform vec3  uSepiaColor;
        uniform float uOutlineThick;
        uniform float uOutlineStr;
        uniform float uOutlineThresh;
        uniform float uLevels;
        uniform float uSepia;
        uniform float uGrain;
        uniform float uVignette;
        uniform float uContrast;
        uniform float uBrightness;
        uniform float uSaturation;
        uniform vec3  uHazeColor;
        uniform float uHaze;

        float linearDepth(vec2 uv) {
          float d = texture2D(tDepth, uv).x;
          float viewZ = perspectiveDepthToViewZ(d, cameraNear, cameraFar);
          return viewZToOrthographicDepth(viewZ, cameraNear, cameraFar);
        }

        float hash(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        void main() {
          vec2 texel = uOutlineThick / resolution;
          vec3 color = texture2D(tDiffuse, vUv).rgb;

          // ---- Ink outline: Sobel-ish on linear depth ----
          float c  = linearDepth(vUv);
          float l  = linearDepth(vUv + vec2(-texel.x, 0.0));
          float r  = linearDepth(vUv + vec2( texel.x, 0.0));
          float u  = linearDepth(vUv + vec2(0.0,  texel.y));
          float dn = linearDepth(vUv + vec2(0.0, -texel.y));
          float edge = abs(l - c) + abs(r - c) + abs(u - c) + abs(dn - c);
          // Scale by depth so distant edges don't over-fire; threshold to ink.
          float ink = smoothstep(uOutlineThresh, uOutlineThresh * 2.2, edge);
          ink *= uOutlineStr;

          // ---- Cel posterize ----
          color = floor(color * uLevels + 0.5) / uLevels;

          // ---- Contrast ----
          color = (color - 0.5) * uContrast + 0.5;

          // ---- Sepia grade (light desaturate toward warm aged tone) ----
          float lum = dot(color, vec3(0.299, 0.587, 0.114));
          vec3 sepia = vec3(lum) * uSepiaColor;
          color = mix(color, sepia, uSepia);
          // gentle warm push
          color.r *= 1.03;
          color.b *= 0.96;

          // ---- Exposure lift + saturation pop (bring the colour back) ----
          color *= uBrightness;
          float lum2 = dot(color, vec3(0.299, 0.587, 0.114));
          color = mix(vec3(lum2), color, uSaturation);

          // ---- Atmospheric haze: fade distance into the warm horizon ----
          // Only affects geometry (depth < 1); the sky keeps its own gradient.
          float dlin = linearDepth(vUv);
          if (dlin < 0.999) {
            float haze = smoothstep(0.12, 0.72, dlin);
            color = mix(color, uHazeColor, haze * uHaze);
          }

          // ---- Ink lines on top (soft, warm) ----
          color = mix(color, uInkColor, ink);

          // ---- Vignette (soft, wide falloff) ----
          float d2 = distance(vUv, vec2(0.5));
          float vig = smoothstep(0.98, 0.48, d2);
          color *= mix(1.0, vig, uVignette);

          // ---- Film grain + faint flicker ----
          float g = hash(vUv * resolution * 0.5 + fract(uTime) * 97.0);
          color += (g - 0.5) * uGrain;
          float flicker = 1.0 + (hash(vec2(uTime * 0.5, 3.1)) - 0.5) * 0.04;
          color *= flicker;

          gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
  }

  // Push any changed style params into the shader uniforms.
  syncParams() {
    const u = this.material.uniforms, p = this.params;
    u.uOutlineThick.value  = p.outlineThickness;
    u.uOutlineStr.value    = p.outlineStrength;
    u.uOutlineThresh.value = p.outlineThreshold;
    u.uLevels.value        = p.posterizeLevels;
    u.uSepia.value         = p.sepiaStrength;
    u.uGrain.value         = p.grainStrength;
    u.uVignette.value      = p.vignetteStrength;
    u.uContrast.value      = p.contrast;
    u.uBrightness.value    = p.brightness;
    u.uSaturation.value    = p.saturation;
    u.uHaze.value          = p.hazeStrength;
  }

  setSize(width, height) {
    const pr = this.renderer.getPixelRatio();
    const w = Math.floor(width * pr), h = Math.floor(height * pr);
    this.target.setSize(w, h);
    this.material.uniforms.resolution.value.set(w, h);
  }

  render(time) {
    if (!this.enabled) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.cameraNear.value = this.camera.near;
    this.material.uniforms.cameraFar.value = this.camera.far;

    // 1) scene → offscreen (colour + depth)
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    // 2) fullscreen cartoon pass → screen
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
  }
}
