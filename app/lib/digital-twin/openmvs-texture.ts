import type { Material, Mesh, Object3D, Texture } from "three";

type MaterialWithMap = Material & { map?: Texture | null };
const OPENMVS_V_FLIP_MARKER = "openMvsVFlipApplied";

export function isOpenMvsGenerator(generator: unknown): generator is string {
  return typeof generator === "string" && generator.toLowerCase().includes("openmvs");
}

export function fixOpenMvsBaseColorTextures(
  root: Object3D,
  generator: unknown,
): number {
  if (!isOpenMvsGenerator(generator)) return 0;

  const textures = new Set<Texture>();
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const map = (material as MaterialWithMap).map;
      if (map) textures.add(map);
    }
  });

  let changed = 0;
  for (const texture of textures) {
    if (texture.userData[OPENMVS_V_FLIP_MARKER]) continue;

    // GLTFLoader commonly decodes GLB images as ImageBitmap, for which the
    // WebGL UNPACK_FLIP_Y flag is ignored. Flip the texture transform instead;
    // this works for both ImageBitmap and HTMLImageElement-backed textures.
    const previousRepeatY = texture.repeat.y;
    texture.repeat.y = -previousRepeatY;
    texture.offset.y += previousRepeatY;
    texture.updateMatrix();
    texture.userData[OPENMVS_V_FLIP_MARKER] = true;
    texture.needsUpdate = true;
    changed += 1;
  }
  return changed;
}
