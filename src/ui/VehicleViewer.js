import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// A self-contained 3D showroom for the garage. Renders one vehicle on a
// turntable platform inside its own canvas/renderer, with drag-to-rotate,
// scroll-to-zoom, and gentle auto-rotation. Only Car1.glb exists for now, so
// the playable car shows native materials and locked vehicles are rendered as a
// darkened "locked" silhouette of the same model (swap in per-vehicle model
// paths here once more GLBs are available).
let cachedGLTF = null; // shared across viewer instances (one network load)

export class VehicleViewer {
  constructor(container) {
    this.container = container;
    const w = container.clientWidth || 600;
    const h = container.clientHeight || 320;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14141b);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    this.camera.position.set(4.5, 2.4, 5.5);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    // Lighting — a bright key, soft fill, and a cool rim for some showroom pop.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a4a, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(5, 8, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 30;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.7);
    rim.position.set(-6, 4, -5);
    this.scene.add(rim);

    // Turntable platform.
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(2.7, 2.9, 0.2, 56),
      new THREE.MeshStandardMaterial({ color: 0x23232f, roughness: 0.85, metalness: 0.15 })
    );
    disc.position.y = -0.1;
    disc.receiveShadow = true;
    this.scene.add(disc);

    // Orbit controls — rotate + limited zoom, no panning, auto-spin when idle.
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 3.5;
    this.controls.maxDistance = 9;
    this.controls.maxPolarAngle = Math.PI * 0.49; // stay above the floor
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 1.3;
    this.controls.target.set(0, 0.55, 0);

    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);

    this._onResize = () => this.#resize();
    window.addEventListener('resize', this._onResize);

    this.renderer.setAnimationLoop(() => this.#frame());
    this.#loadModel();
  }

  #loadModel() {
    if (cachedGLTF) { this._gltf = cachedGLTF; this.#rebuild(); return; }
    new GLTFLoader().load(
      './Car1.glb',
      (gltf) => { cachedGLTF = gltf; this._gltf = gltf; this.#rebuild(); },
      undefined,
      (err) => console.warn('VehicleViewer: Car1.glb failed to load', err)
    );
  }

  // vehicle: { name, color, playable, unlockCost }
  showVehicle(vehicle) {
    this.vehicle = vehicle;
    this.#rebuild();
    // Reset the spin so each newly selected car starts from the same angle.
    this.controls.autoRotate = true;
  }

  #rebuild() {
    while (this.modelGroup.children.length) this.modelGroup.remove(this.modelGroup.children[0]);
    if (!this._gltf || !this.vehicle) return;

    const model = this._gltf.scene.clone(true);

    // Scale + sit on the platform, centred.
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = 3.4 / Math.max(size.x, size.z);
    model.scale.setScalar(scale);
    model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
    model.rotation.y = Math.PI; // front faces the default camera angle

    const locked = !this.vehicle.playable;
    model.traverse((c) => {
      if (c.isMesh) {
        c.castShadow = true;
        c.receiveShadow = false;
        // Clone the material so tinting one vehicle never mutates the cache.
        c.material = c.material.clone();
        if (locked) {
          // Dark, matte "locked" silhouette — clearly not yet owned.
          c.material.color.setHex(0x1d1d26);
          c.material.metalness = 0.05;
          c.material.roughness = 0.95;
        }
      }
    });
    this.modelGroup.add(model);
  }

  #frame() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  #resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this._onResize);
    this.controls.dispose();
    this.renderer.dispose();
    const el = this.renderer.domElement;
    if (el.parentNode) el.parentNode.removeChild(el);
  }
}
