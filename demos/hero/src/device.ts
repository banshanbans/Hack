import * as THREE from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HERO_CONFIG} from './hero.config';

export interface HeroDevice {
  readonly root: THREE.Group;
  readonly screenMaterial: THREE.MeshBasicMaterial;
  readonly glassMaterial: THREE.MeshPhysicalMaterial;
  readonly metalMaterial: THREE.MeshPhysicalMaterial;
  setScreenTexture: (texture: THREE.Texture) => void;
  loadModel: (url: string) => Promise<void>;
  dispose: () => void;
}

function collectMaterialResources(
  material: THREE.Material,
  materials: Set<THREE.Material>,
  textures: Set<THREE.Texture>,
): void {
  if (materials.has(material)) return;
  materials.add(material);
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) textures.add(value);
  }
}

function disposeObjectResources(object: THREE.Object3D, protectedMaterials = new Set<THREE.Material>()): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  object.traverse(child => {
    if (!(child instanceof THREE.Mesh)) return;
    geometries.add(child.geometry);
    const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of childMaterials) {
      if (!protectedMaterials.has(material)) collectMaterialResources(material, materials, textures);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
}

function disposeDetachedMaterials(detachedMaterials: Iterable<THREE.Material>): void {
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  for (const material of detachedMaterials) collectMaterialResources(material, materials, textures);
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
}

function transformScreenUvs(
  geometry: THREE.BufferGeometry,
  radians: number,
  flipX: boolean,
  flipY: boolean,
): void {
  if (Math.abs(radians) < Number.EPSILON && !flipX && !flipY) return;
  const uv = geometry.getAttribute('uv');
  if (!(uv instanceof THREE.BufferAttribute)) throw new Error('GLB screen mesh has no usable UV coordinates.');
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  for (let index = 0; index < uv.count; index += 1) {
    const x = uv.getX(index) - 0.5;
    const y = uv.getY(index) - 0.5;
    const rotatedX = x * cosine - y * sine;
    const rotatedY = x * sine + y * cosine;
    uv.setXY(index, (flipX ? -rotatedX : rotatedX) + 0.5, (flipY ? -rotatedY : rotatedY) + 0.5);
  }
  uv.needsUpdate = true;
}

function roundedRectangle(width: number, height: number, radius: number): THREE.Shape {
  const left = -width / 2;
  const right = width / 2;
  const bottom = -height / 2;
  const top = height / 2;
  const shape = new THREE.Shape();
  shape.moveTo(left + radius, bottom);
  shape.lineTo(right - radius, bottom);
  shape.quadraticCurveTo(right, bottom, right, bottom + radius);
  shape.lineTo(right, top - radius);
  shape.quadraticCurveTo(right, top, right - radius, top);
  shape.lineTo(left + radius, top);
  shape.quadraticCurveTo(left, top, left, top - radius);
  shape.lineTo(left, bottom + radius);
  shape.quadraticCurveTo(left, bottom, left + radius, bottom);
  return shape;
}

function capsuleGeometry(width: number, height: number): THREE.ShapeGeometry {
  return new THREE.ShapeGeometry(roundedRectangle(width, height, height / 2), 32);
}

function roundedPlaneGeometry(width: number, height: number, radius: number): THREE.ShapeGeometry {
  const geometry = new THREE.ShapeGeometry(roundedRectangle(width, height, radius), 48);
  const position = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let index = 0; index < position.count; index += 1) {
    uv.setXY(index, position.getX(index) / width + 0.5, position.getY(index) / height + 0.5);
  }
  uv.needsUpdate = true;
  return geometry;
}

function addSideControls(group: THREE.Group, material: THREE.Material): void {
  const buttonGeometry = (width: number, height: number) => new RoundedBoxGeometry(width, height, 0.11, 5, 0.055);

  const action = new THREE.Mesh(buttonGeometry(0.1, 0.62), material);
  action.position.set(-3.31, 4.28, 0.08);
  action.rotation.y = Math.PI / 2;
  group.add(action);

  for (const y of [2.78, 1.42]) {
    const volume = new THREE.Mesh(buttonGeometry(0.11, 1.12), material);
    volume.position.set(-3.32, y, 0.04);
    volume.rotation.y = Math.PI / 2;
    group.add(volume);
  }

  const power = new THREE.Mesh(buttonGeometry(0.11, 1.78), material);
  power.position.set(3.32, 2.68, 0.02);
  power.rotation.y = Math.PI / 2;
  group.add(power);
}

function addAntennaLines(group: THREE.Group): void {
  const material = new THREE.MeshStandardMaterial({color: 0x4e4c49, metalness: 0.08, roughness: 0.48});
  const vertical = new THREE.BoxGeometry(0.015, 0.34, 0.64);
  for (const x of [-3.279, 3.279]) {
    for (const y of [-4.92, 4.92]) {
      const line = new THREE.Mesh(vertical, material);
      line.position.set(x, y, 0);
      group.add(line);
    }
  }
}

function addRearCamera(group: THREE.Group): void {
  const bumpMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x1d1d1d,
    metalness: 0.88,
    roughness: 0.25,
    clearcoat: 0.62,
    clearcoatRoughness: 0.18,
  });
  const lensMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x030609,
    metalness: 0.25,
    roughness: 0.08,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
  });
  const bump = new THREE.Mesh(new RoundedBoxGeometry(2.48, 2.48, 0.18, 8, 0.42), bumpMaterial);
  bump.position.set(-1.66, 4.84, -0.46);
  group.add(bump);

  for (const [x, y] of [[-2.12, 5.36], [-1.2, 5.23], [-2.02, 4.36]] as const) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.47, 0.47, 0.19, 40), bumpMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, y, -0.62);
    group.add(ring);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.365, 0.365, 0.205, 40), lensMaterial);
    lens.rotation.x = Math.PI / 2;
    lens.position.set(x, y, -0.72);
    group.add(lens);
    const glint = new THREE.Mesh(
      new THREE.CircleGeometry(0.075, 20),
      new THREE.MeshBasicMaterial({color: 0x7695a3, transparent: true, opacity: 0.42}),
    );
    glint.position.set(x - 0.1, y + 0.1, -0.828);
    glint.rotation.y = Math.PI;
    group.add(glint);
  }
}

function addBottomDetails(group: THREE.Group): void {
  const darkMetal = new THREE.MeshStandardMaterial({color: 0x191919, metalness: 0.7, roughness: 0.3});
  const port = new THREE.Mesh(new RoundedBoxGeometry(0.92, 0.09, 0.22, 4, 0.04), darkMetal);
  port.rotation.x = Math.PI / 2;
  port.position.set(0, -6.886, 0);
  group.add(port);
  for (const x of [-2.2, -1.86, -1.52, 1.52, 1.86, 2.2]) {
    const speaker = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.18, 14), darkMetal);
    speaker.rotation.z = Math.PI / 2;
    speaker.position.set(x, -6.89, 0.02);
    group.add(speaker);
  }
}

export function createHeroDevice(initialTexture: THREE.Texture): HeroDevice {
  const root = new THREE.Group();
  root.name = 'hero-iphone';

  const proceduralModel = new THREE.Group();
  proceduralModel.name = 'procedural-device';
  root.add(proceduralModel);

  const metalMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x77746f,
    metalness: 1,
    roughness: 0.2,
    clearcoat: 0.82,
    clearcoatRoughness: 0.16,
    envMapIntensity: 1.4,
  });
  const darkTitanium = new THREE.MeshPhysicalMaterial({
    color: 0x242321,
    metalness: 0.94,
    roughness: 0.24,
    clearcoat: 0.6,
    clearcoatRoughness: 0.2,
  });
  const body = new THREE.Mesh(new RoundedBoxGeometry(6.62, 13.72, 0.72, 10, 0.72), metalMaterial);
  proceduralModel.add(body);

  const innerRail = new THREE.Mesh(new RoundedBoxGeometry(6.49, 13.59, 0.75, 10, 0.69), darkTitanium);
  innerRail.position.z = 0.006;
  proceduralModel.add(innerRail);
  addSideControls(proceduralModel, metalMaterial);
  addAntennaLines(proceduralModel);
  addRearCamera(proceduralModel);
  addBottomDetails(proceduralModel);

  const frontAssembly = new THREE.Group();
  frontAssembly.name = 'screen-assembly';
  root.add(frontAssembly);

  const frontGlassBase = new THREE.Mesh(
    new RoundedBoxGeometry(6.36, 13.46, 0.14, 10, 0.68),
    new THREE.MeshPhysicalMaterial({color: 0x020202, metalness: 0.02, roughness: 0.18, clearcoat: 1}),
  );
  frontGlassBase.position.z = 0.405;
  frontAssembly.add(frontGlassBase);

  const screenMaterial = new THREE.MeshBasicMaterial({map: initialTexture, color: 0xffffff, toneMapped: false});
  const screen = new THREE.Mesh(
    roundedPlaneGeometry(
      HERO_CONFIG.device.screenWidth,
      HERO_CONFIG.device.screenHeight,
      HERO_CONFIG.device.screenCornerRadius,
    ),
    screenMaterial,
  );
  screen.position.z = 0.486;
  frontAssembly.add(screen);

  const glassMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.045,
    roughness: 0.045,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.015,
    depthWrite: false,
  });
  const glass = new THREE.Mesh(
    roundedPlaneGeometry(
      HERO_CONFIG.device.screenWidth,
      HERO_CONFIG.device.screenHeight,
      HERO_CONFIG.device.screenCornerRadius,
    ),
    glassMaterial,
  );
  glass.position.z = 0.505;
  frontAssembly.add(glass);

  const islandMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x010101,
    roughness: 0.16,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
  });
  const island = new THREE.Mesh(capsuleGeometry(1.72, 0.48), islandMaterial);
  island.position.set(0, 5.77, 0.535);
  frontAssembly.add(island);

  const sensor = new THREE.Mesh(
    new THREE.CircleGeometry(0.075, 24),
    new THREE.MeshPhysicalMaterial({color: 0x0e1d26, roughness: 0.08, clearcoat: 1}),
  );
  sensor.position.set(0.56, 5.77, 0.542);
  frontAssembly.add(sensor);

  let loadedModel: THREE.Object3D | null = null;
  let loadedModelDetachedMaterials = new Set<THREE.Material>();
  let disposed = false;

  const setScreenTexture = (texture: THREE.Texture) => {
    const previous = screenMaterial.map;
    screenMaterial.map = texture;
    screenMaterial.needsUpdate = true;
    if (previous && previous !== initialTexture && previous !== texture) previous.dispose();
  };

  const loadModel = async (url: string) => {
    if (!url) return;
    const gltf = await new GLTFLoader().loadAsync(url);
    const model = gltf.scene;
    if (disposed) {
      disposeObjectResources(model);
      return;
    }
    model.rotation.set(...HERO_CONFIG.device.modelRotation);
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    if (!Number.isFinite(size.y) || size.y <= 0) throw new Error('GLB model has invalid bounds.');
    const scale = HERO_CONFIG.device.modelHeight / size.y;
    model.scale.setScalar(scale);
    const normalizedBounds = new THREE.Box3().setFromObject(model);
    const center = normalizedBounds.getCenter(new THREE.Vector3());
    model.position.sub(center);
    model.position.add(new THREE.Vector3(...HERO_CONFIG.device.modelOffset));
    const detachedMaterials = new Set<THREE.Material>();
    const hasScreenBinding = Boolean(
      HERO_CONFIG.device.modelScreenMeshName || HERO_CONFIG.device.modelScreenMaterialName,
    );
    let screenMeshFound = !hasScreenBinding;
    model.traverse(child => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = false;
        child.receiveShadow = false;
        const existingMaterials = Array.isArray(child.material) ? child.material : [child.material];
        const isScreenMesh = child.name === HERO_CONFIG.device.modelScreenMeshName
          || existingMaterials.some(material => material.name === HERO_CONFIG.device.modelScreenMaterialName);
        if (isScreenMesh) {
          for (const material of existingMaterials) detachedMaterials.add(material);
          transformScreenUvs(
            child.geometry,
            HERO_CONFIG.device.modelScreenUvRotation,
            HERO_CONFIG.device.modelScreenUvFlipX,
            HERO_CONFIG.device.modelScreenUvFlipY,
          );
          child.material = screenMaterial;
          child.renderOrder = 1;
          screenMeshFound = true;
        }
      }
    });
    if (!screenMeshFound) {
      disposeObjectResources(model);
      throw new Error('GLB screen mesh binding was not found.');
    }
    if (loadedModel) {
      root.remove(loadedModel);
      disposeObjectResources(loadedModel, new Set([screenMaterial]));
      disposeDetachedMaterials(loadedModelDetachedMaterials);
    }
    loadedModel = model;
    loadedModelDetachedMaterials = detachedMaterials;
    root.add(model);
    proceduralModel.visible = false;
    frontAssembly.visible = !hasScreenBinding;
  };

  const dispose = () => {
    disposed = true;
    disposeObjectResources(root);
    disposeDetachedMaterials(loadedModelDetachedMaterials);
    loadedModelDetachedMaterials.clear();
  };

  return {root, screenMaterial, glassMaterial, metalMaterial, setScreenTexture, loadModel, dispose};
}
