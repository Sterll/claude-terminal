/**
 * Three.js 3D Viewer Module (ESM, lazy-loaded)
 * Renders .obj, .stl, .gltf/.glb models with OrbitControls.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Render a 3D model into the given container.
 * @param {HTMLElement} container - The .file-viewer-3d element
 * @param {string} fileUrl - file:/// URL to the model
 * @param {string} ext - File extension (obj, stl, gltf, glb)
 * @returns {{ destroy: () => void }}
 */
export function render3D(container, fileUrl, ext) {
  let destroyed = false;
  let animFrameId = null;
  let model = null;
  let wireframeEnabled = false;
  let gridVisible = true;

  // Scene setup
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);

  // Camera
  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
  camera.position.set(3, 2, 3);

  // Renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  container.appendChild(renderer.domElement);

  // Controls
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.1;
  controls.maxDistance = 500;

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(5, 10, 7);
  scene.add(dirLight);

  const backLight = new THREE.DirectionalLight(0xffffff, 0.3);
  backLight.position.set(-5, 5, -5);
  scene.add(backLight);

  // Grid
  const grid = new THREE.GridHelper(10, 20, 0x444466, 0x333355);
  grid.material.opacity = 0.5;
  grid.material.transparent = true;
  scene.add(grid);

  // Info overlay
  const infoDiv = document.createElement('div');
  infoDiv.className = 'file-viewer-3d-info';
  infoDiv.textContent = 'Loading...';
  container.appendChild(infoDiv);

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'file-viewer-3d-toolbar';
  toolbar.innerHTML = `
    <button class="viewer-3d-btn viewer-3d-reset" title="Reset view">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
    </button>
    <button class="viewer-3d-btn viewer-3d-wireframe" title="Wireframe">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
    </button>
    <button class="viewer-3d-btn viewer-3d-grid active" title="Toggle grid">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18"/></svg>
    </button>
  `;
  container.appendChild(toolbar);

  const resetBtn = toolbar.querySelector('.viewer-3d-reset');
  const wireframeBtn = toolbar.querySelector('.viewer-3d-wireframe');
  const gridBtn = toolbar.querySelector('.viewer-3d-grid');

  resetBtn.addEventListener('click', resetView);
  wireframeBtn.addEventListener('click', toggleWireframe);
  gridBtn.addEventListener('click', toggleGrid);

  // Resize handling
  const resizeObserver = new ResizeObserver(() => {
    if (destroyed) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resizeObserver.observe(container);

  // Initial size
  const w = container.clientWidth || 800;
  const h = container.clientHeight || 600;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);

  // Animation loop
  function animate() {
    if (destroyed) return;
    animFrameId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  // Load model
  loadModel(fileUrl, ext);

  async function loadModel(url, extension) {
    try {
      let loaded;
      switch (extension) {
        case 'obj':
          loaded = await loadOBJ(url);
          break;
        case 'stl':
          loaded = await loadSTL(url);
          break;
        case 'gltf':
        case 'glb':
          loaded = await loadGLTF(url);
          break;
        default:
          infoDiv.textContent = 'Unsupported format';
          return;
      }

      if (destroyed) return;
      model = loaded;
      scene.add(model);
      centerModel(model);
      updateInfo(model);
    } catch (err) {
      if (destroyed) return;
      infoDiv.textContent = `Error: ${err.message}`;
    }
  }

  function loadOBJ(url) {
    return new Promise((resolve, reject) => {
      const loader = new OBJLoader();
      loader.load(url, (obj) => {
        // Apply default material if none
        obj.traverse(child => {
          if (child.isMesh && !child.material.map) {
            child.material = new THREE.MeshPhongMaterial({
              color: 0x8888aa,
              shininess: 30,
              flatShading: false
            });
          }
        });
        resolve(obj);
      }, undefined, reject);
    });
  }

  function loadSTL(url) {
    return new Promise((resolve, reject) => {
      const loader = new STLLoader();
      loader.load(url, (geometry) => {
        geometry.computeVertexNormals();
        const material = new THREE.MeshPhongMaterial({
          color: 0x8888aa,
          shininess: 40,
          flatShading: false
        });
        const mesh = new THREE.Mesh(geometry, material);
        resolve(mesh);
      }, undefined, reject);
    });
  }

  function loadGLTF(url) {
    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader();
      loader.load(url, (gltf) => {
        resolve(gltf.scene);
      }, undefined, reject);
    });
  }

  function centerModel(obj) {
    const box = new THREE.Box3().setFromObject(obj);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    // Center the model
    obj.position.sub(center);

    // Adjust camera
    const fitDist = maxDim * 1.5;
    camera.position.set(fitDist * 0.7, fitDist * 0.5, fitDist * 0.7);
    controls.target.set(0, 0, 0);
    controls.update();

    // Adjust grid to match model scale
    const gridSize = Math.max(maxDim * 2, 10);
    grid.scale.set(gridSize / 10, 1, gridSize / 10);
    grid.position.y = -size.y / 2;

    // Adjust camera far plane
    camera.far = fitDist * 10;
    camera.near = fitDist * 0.001;
    camera.updateProjectionMatrix();
  }

  function updateInfo(obj) {
    let vertices = 0;
    let faces = 0;
    obj.traverse(child => {
      if (child.isMesh && child.geometry) {
        const geo = child.geometry;
        vertices += geo.attributes.position ? geo.attributes.position.count : 0;
        faces += geo.index ? geo.index.count / 3 : (geo.attributes.position ? geo.attributes.position.count / 3 : 0);
      }
    });
    infoDiv.textContent = `${formatNumber(vertices)} vertices \u00B7 ${formatNumber(Math.floor(faces))} faces`;
  }

  function formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function resetView() {
    if (!model) return;
    centerModel(model);
  }

  function toggleWireframe() {
    wireframeEnabled = !wireframeEnabled;
    wireframeBtn.classList.toggle('active', wireframeEnabled);
    if (model) {
      model.traverse(child => {
        if (child.isMesh && child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(m => { m.wireframe = wireframeEnabled; });
          } else {
            child.material.wireframe = wireframeEnabled;
          }
        }
      });
    }
  }

  function toggleGrid() {
    gridVisible = !gridVisible;
    grid.visible = gridVisible;
    gridBtn.classList.toggle('active', gridVisible);
  }

  return {
    destroy() {
      destroyed = true;
      resizeObserver.disconnect();

      if (animFrameId !== null) {
        cancelAnimationFrame(animFrameId);
      }

      controls.dispose();

      // Dispose all geometries and materials
      scene.traverse(child => {
        if (child.isMesh) {
          if (child.geometry) child.geometry.dispose();
          if (child.material) {
            if (Array.isArray(child.material)) {
              child.material.forEach(m => m.dispose());
            } else {
              child.material.dispose();
            }
          }
        }
      });

      renderer.dispose();
      renderer.domElement.remove();
      model = null;
    }
  };
}
