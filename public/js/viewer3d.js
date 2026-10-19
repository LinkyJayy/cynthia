// Renders Cynthia's 3D models (.model3d.json) with three.js: thumbnails, an interactive viewer and exports.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';

const DEG = Math.PI / 180;
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function geometryFor(p) {
  const s = p.size || {};
  const pts = Array.isArray(p.points) ? p.points.filter((q) => Array.isArray(q) && q.length >= 2) : [];
  switch (p.shape) {
    case 'box': return new THREE.BoxGeometry(num(s.width, 1), num(s.height, 1), num(s.depth, 1));
    case 'sphere': return new THREE.SphereGeometry(num(s.radius, 0.5), 48, 32);
    case 'cylinder': return new THREE.CylinderGeometry(num(s.radiusTop, num(s.radius, 0.5)), num(s.radiusBottom, num(s.radius, 0.5)), num(s.height, 1), 48);
    case 'cone': return new THREE.ConeGeometry(num(s.radius, num(s.radiusBottom, 0.5)), num(s.height, 1), 48);
    case 'torus': return new THREE.TorusGeometry(num(s.radius, 0.5), num(s.tube, 0.15), 24, 64);
    case 'capsule': return new THREE.CapsuleGeometry(num(s.radius, 0.3), num(s.length, num(s.height, 1)), 12, 24);
    case 'plane': return new THREE.PlaneGeometry(num(s.width, 1), num(s.height, num(s.depth, 1)));
    case 'icosahedron': return new THREE.IcosahedronGeometry(num(s.radius, 0.5));
    case 'octahedron': return new THREE.OctahedronGeometry(num(s.radius, 0.5));
    case 'tetrahedron': return new THREE.TetrahedronGeometry(num(s.radius, 0.5));
    case 'dodecahedron': return new THREE.DodecahedronGeometry(num(s.radius, 0.5));
    case 'lathe':
      if (pts.length >= 2) return new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(Math.max(0, x), y)), 64);
      break;
    case 'extrude':
      if (pts.length >= 3) {
        const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
        const g = new THREE.ExtrudeGeometry(shape, { depth: num(s.depth, 0.2), bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.01, bevelSegments: 2 });
        g.translate(0, 0, -num(s.depth, 0.2) / 2);
        return g;
      }
      break;
  }
  return new THREE.BoxGeometry(0.2, 0.2, 0.2);
}

export function buildModel(model) {
  const group = new THREE.Group();
  group.name = model.name || 'model';
  for (const p of model.parts || []) {
    let color;
    try {
      color = new THREE.Color(p.color || '#b9a3e3');
    } catch {
      color = new THREE.Color('#b9a3e3');
    }
    const opacity = num(p.opacity, 1);
    const mat = new THREE.MeshStandardMaterial({
      color,
      metalness: num(p.metalness, 0.05),
      roughness: num(p.roughness, 0.6),
      transparent: opacity < 1,
      opacity,
      side: p.shape === 'plane' || p.shape === 'lathe' ? THREE.DoubleSide : THREE.FrontSide,
    });
    if (p.emissive) {
      try {
        mat.emissive = new THREE.Color(p.emissive);
        mat.emissiveIntensity = 0.8;
      } catch {}
    }
    const mesh = new THREE.Mesh(geometryFor(p), mat);
    mesh.name = p.name || p.shape;
    const [px, py, pz] = p.position || [];
    mesh.position.set(num(px, 0), num(py, 0), num(pz, 0));
    const [rx, ry, rz] = p.rotation || [];
    mesh.rotation.set(num(rx, 0) * DEG, num(ry, 0) * DEG, num(rz, 0) * DEG);
    const [sx, sy, sz] = p.scale || [];
    mesh.scale.set(num(sx, 1), num(sy, 1), num(sz, 1));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

function makeScene(model) {
  const scene = new THREE.Scene();
  let bg;
  try {
    bg = new THREE.Color(model.background || '#1b1233');
  } catch {
    bg = new THREE.Color('#1b1233');
  }
  scene.background = bg;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x443366, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(4, 8, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xc49bff, 0.8);
  rim.position.set(-6, 3, -5);
  scene.add(rim);
  const obj = buildModel(model);
  scene.add(obj);
  return { scene, obj, key };
}

function frame(camera, obj, controls) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 0.1);
  const dist = radius / Math.sin((camera.fov * DEG) / 2);
  camera.position.copy(center).add(new THREE.Vector3(0.9, 0.55, 1.15).normalize().multiplyScalar(dist * 1.05));
  camera.near = dist / 100;
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  camera.lookAt(center);
  if (controls) {
    controls.target.copy(center);
    controls.update();
  }
  return { box, radius };
}

// ---- Thumbnails share one offscreen renderer (browsers limit WebGL contexts).
let thumbRenderer;
const thumbCache = new Map();
export async function thumbnail(model, key) {
  if (key && thumbCache.has(key)) return thumbCache.get(key);
  thumbRenderer ??= new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  thumbRenderer.setSize(480, 360, false);
  const { scene, obj } = makeScene(model);
  const camera = new THREE.PerspectiveCamera(40, 4 / 3);
  frame(camera, obj);
  thumbRenderer.render(scene, camera);
  const url = thumbRenderer.domElement.toDataURL('image/jpeg', 0.85);
  disposeScene(scene);
  if (key) thumbCache.set(key, url);
  return url;
}

function disposeScene(scene) {
  scene.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose?.();
  });
}

// ---- Full-screen viewer
let current = null;
export function openViewer(container, model) {
  closeViewer();
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  const { scene, obj, key } = makeScene(model);
  const camera = new THREE.PerspectiveCamera(40, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.2;
  controls.addEventListener('start', () => (controls.autoRotate = false));
  const { box, radius } = frame(camera, obj, controls);

  // soft ground for shadows
  const ground = new THREE.Mesh(new THREE.CircleGeometry(radius * 3, 64), new THREE.ShadowMaterial({ opacity: 0.25 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = box.min.y - 0.001;
  ground.receiveShadow = true;
  scene.add(ground);
  key.shadow.camera.left = key.shadow.camera.bottom = -radius * 2;
  key.shadow.camera.right = key.shadow.camera.top = radius * 2;

  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
  let raf;
  const loop = () => {
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  loop();
  current = { renderer, scene, obj, ro, stop: () => cancelAnimationFrame(raf), container, controls, name: model.name || 'model' };
}

export function closeViewer() {
  if (!current) return;
  current.stop();
  current.ro.disconnect();
  current.controls.dispose();
  disposeScene(current.scene);
  current.renderer.dispose();
  current.renderer.domElement.remove();
  current = null;
}

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export async function exportCurrent(format) {
  if (!current) return;
  const name = (current.name || 'model').replace(/[^\w-]+/g, '_');
  if (format === 'glb') {
    const result = await new GLTFExporter().parseAsync(current.obj, { binary: true });
    download(new Blob([result], { type: 'model/gltf-binary' }), `${name}.glb`);
  } else if (format === 'stl') {
    const result = new STLExporter().parse(current.obj, { binary: true });
    download(new Blob([result], { type: 'model/stl' }), `${name}.stl`);
  } else if (format === 'obj') {
    download(new Blob([new OBJExporter().parse(current.obj)], { type: 'text/plain' }), `${name}.obj`);
  }
}
