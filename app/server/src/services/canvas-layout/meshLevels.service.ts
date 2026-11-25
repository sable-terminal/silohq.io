// A 3D asset model's levels of detail and compression at upload (spec 29.5: "mesh compression
// applied where absent; up to three levels of detail generated at upload"; D249).
//
// The checked model (spatialAsset.util.ts) is read with glTF Transform and written again:
// - level 0, the full model, compressed with EXT_meshopt_compression where it has no mesh
//   compression (filters before lossless compression: positions, normals and texture
//   coordinates lose precision a viewer does not see);
// - levels 1 and 2, each triangle mesh simplified to a half and to a seventh of its triangles
//   (meshoptimizer: seams welded by position, then the precise simplifier, or a coarse one where
//   that cannot get there), its vertices compacted, compressed the same way.
// Nothing else changes: every node, its name and transform (anchors name nodes), materials and
// textures stay. A level is kept only where it is at least a quarter smaller than the one before.
// A primitive that is not a triangle list, or has morph targets, is kept whole in every level.
// A model compressed with Draco is served as it came: decoding it needs a library this build
// does not hold.

import { Accessor, NodeIO, Primitive, type Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

export interface ModelLevel {
  level: number;
  glb: Buffer;
  triangles: number;
  /** The share of the full model's triangles this level keeps, 1 for the full model. */
  ratio: number;
}

export interface ModelLevels {
  levels: ModelLevel[];
  /** applied: this build compressed it; kept: it came compressed (meshopt or Draco); none: nothing to compress, or compressing made it no smaller. */
  compression: 'meshopt_applied' | 'meshopt_kept' | 'draco_kept' | 'none';
}

/** The simplified levels: the share of triangles each keeps and the error it may reach, relative to the mesh's size. */
const LEVELS = [{ ratio: 0.5, error: 0.02 }, { ratio: 0.15, error: 0.08 }] as const;
const SMALLER_BY = 0.75;

let io: NodeIO | undefined;
async function reader(): Promise<NodeIO> {
  if (io === undefined) {
    await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
    io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  }
  return io;
}

const triangleLists = (doc: Document): Primitive[] => doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives())
  .filter((p) => p.getMode() === Primitive.Mode.TRIANGLES && p.getAttribute('POSITION') !== null && p.listTargets().length === 0);

const trianglesOf = (doc: Document): number => doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives())
  .filter((p) => p.getMode() === Primitive.Mode.TRIANGLES)
  .reduce((n, p) => n + Math.floor((p.getIndices()?.getCount() ?? p.getAttribute('POSITION')?.getCount() ?? 0) / 3), 0);

/** An accessor's elements as 32-bit floats, whatever it stores. */
function floats(accessor: Accessor): Float32Array {
  const array = accessor.getArray();
  if (array instanceof Float32Array && !accessor.getNormalized()) return array;
  const size = accessor.getElementSize();
  const out = new Float32Array(accessor.getCount() * size);
  const element: number[] = [];
  for (let i = 0; i < accessor.getCount(); i++) {
    accessor.getElement(i, element);
    for (let k = 0; k < size; k++) out[i * size + k] = element[k]!;
  }
  return out;
}

/** Simplifies one triangle list to about `ratio` of its triangles, its vertices compacted; false where nothing was gained. */
function simplifyPrimitive(doc: Document, primitive: Primitive, ratio: number, error: number): boolean {
  const position = primitive.getAttribute('POSITION')!;
  const positions = floats(position);
  const vertices = position.getCount();
  const given = primitive.getIndices()?.getArray();
  const indices = given === undefined || given === null ? Uint32Array.from({ length: vertices - (vertices % 3) }, (_, i) => i) : Uint32Array.from(given);
  if (indices.length < 6) return false;
  // Seams welded by position, so the simplifier sees one surface; each corner then takes the welded vertex's attributes.
  const weld = MeshoptSimplifier.generatePositionRemap(positions, 3);
  const welded = indices.map((i) => weld[i]!);
  const target = Math.max(3, Math.floor((indices.length * ratio) / 3) * 3);
  let [simplified] = MeshoptSimplifier.simplify(welded, positions, 3, target, error, ['Prune']);
  if (simplified.length > target * 1.3) [simplified] = MeshoptSimplifier.simplifySloppy(welded, positions, 3, null, target, error * 4);
  if (simplified.length === 0 || simplified.length >= indices.length) return false;
  const [remap, unique] = MeshoptSimplifier.compactMesh(simplified);
  for (const semantic of primitive.listSemantics()) {
    const old = primitive.getAttribute(semantic)!;
    const size = old.getElementSize();
    const source = old.getArray()!;
    const out = new (source.constructor as new (n: number) => typeof source)(unique * size);
    for (let v = 0; v < remap.length; v++) {
      const to = remap[v]!;
      if (to === 0xffffffff) continue;
      for (let k = 0; k < size; k++) out[to * size + k] = source[v * size + k]!;
    }
    primitive.setAttribute(semantic, doc.createAccessor().setType(old.getType()).setArray(out).setNormalized(old.getNormalized()).setBuffer(old.getBuffer()));
  }
  const indexArray = unique <= 0xffff ? Uint16Array.from(simplified) : Uint32Array.from(simplified);
  primitive.setIndices(doc.createAccessor().setType('SCALAR').setArray(indexArray).setBuffer(position.getBuffer()));
  return true;
}

/** Disposes of accessors nothing uses any more (the ones a simplification replaced). */
function dropUnused(doc: Document): void {
  for (const accessor of doc.getRoot().listAccessors()) {
    if (accessor.listParents().every((p) => p === doc.getRoot())) accessor.dispose();
  }
}

async function compressed(doc: Document): Promise<Buffer> {
  const io = await reader();
  if (doc.getRoot().listExtensionsUsed().every((e) => e.extensionName !== EXTMeshoptCompression.EXTENSION_NAME)) {
    doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
    // The filters store normals and texture coordinates as normalised integers, which glTF allows under KHR_mesh_quantization.
    doc.createExtension(KHRMeshQuantization).setRequired(true);
  }
  return Buffer.from(await io.writeBinary(doc));
}

/** The levels a checked model is served at (see the header). */
export async function modelLevels(glb: Buffer): Promise<ModelLevels> {
  const io = await reader();
  const source = await io.readBinary(new Uint8Array(glb.buffer, glb.byteOffset, glb.byteLength));
  const used = source.getRoot().listExtensionsUsed().map((e) => e.extensionName);
  const total = trianglesOf(source);
  if (used.includes('KHR_draco_mesh_compression')) {
    return { levels: [{ level: 0, glb, triangles: total, ratio: 1 }], compression: 'draco_kept' };
  }
  const came = used.includes(EXTMeshoptCompression.EXTENSION_NAME);
  if (triangleLists(source).length === 0) {
    return { levels: [{ level: 0, glb, triangles: total, ratio: 1 }], compression: came ? 'meshopt_kept' : 'none' };
  }
  // The full model compressed where that makes it smaller (a model of a few boxes is not).
  const squeezed = came ? glb : await compressed(source);
  const applied = !came && squeezed.length < glb.length;
  const levels: ModelLevel[] = [{ level: 0, glb: applied ? squeezed : glb, triangles: total, ratio: 1 }];
  for (const { ratio, error } of LEVELS) {
    const doc = await io.readBinary(new Uint8Array(glb.buffer, glb.byteOffset, glb.byteLength));
    let changed = false;
    for (const primitive of triangleLists(doc)) changed = simplifyPrimitive(doc, primitive, ratio, error) || changed;
    if (!changed) break;
    dropUnused(doc);
    const bytes = await compressed(doc);
    const triangles = trianglesOf(doc);
    const before = levels.at(-1)!;
    if (bytes.length > before.glb.length * SMALLER_BY || triangles >= before.triangles) break;
    levels.push({ level: levels.length, glb: bytes, triangles, ratio: total === 0 ? 0 : Math.round((triangles / total) * 1000) / 1000 });
  }
  return { levels, compression: came ? 'meshopt_kept' : applied ? 'meshopt_applied' : 'none' };
}
